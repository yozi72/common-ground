// Moderation worker. Claims pending messages with the service role, calls the
// gateway, and enforces the decision through apply_moderation_decision — the
// only path that writes approved_messages. Any failure defers the message;
// nothing is ever passed on error.
//
// Claim ownership: every claim (batch or immediate) carries a token and a lease
// (75 s, longer than the model timeout × retries). A result or deferral is
// applied only while that token is the live claim, so a slow worker whose lease
// expired, an overlapping worker, a cancellation or a human decision can never
// be overwritten by a stale automated outcome. A worker that runs out of time
// hands unprocessed claims back without consuming an attempt.
import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { moderate, GatewayError } from "@/lib/ai/gateway";
import { runDetectors } from "@/lib/ai/detectors";
import { generateNextQuestion } from "./questions";
import { Deadline } from "./deadline";

type PendingRow = {
  id: string; conversation_id: string; sender_participant_id: string; kind: "chat" | "answer";
  question_id: string | null; body: string; attempts: number; claim_token: string;
};

export const CLAIM_LEASE_SECONDS = 75;      // ≥ gateway timeout (25 s) × 2 tries + margin
const PER_MESSAGE_BUDGET_MS = 30_000;       // worst case one moderation call incl. a retry
const BATCH = 5;                            // claim in small batches so nothing waits on a long lease

export async function processPendingBatch(limit = 10, deadline: Deadline = Deadline.none()): Promise<{ processed: number; deferred: number; released: number }> {
  const admin = supabaseAdmin();
  const out = { processed: 0, deferred: 0, released: 0 };
  let left = limit;
  while (left > 0 && deadline.remainingMs() > PER_MESSAGE_BUDGET_MS) {
    // never claim more than can plausibly start before the deadline
    const n = Math.min(BATCH, left, Math.max(1, Math.floor(deadline.remainingMs() / PER_MESSAGE_BUDGET_MS)));
    const { data, error } = await admin.rpc("claim_pending", { p_limit: n, p_lease_seconds: CLAIM_LEASE_SECONDS });
    if (error) throw new Error(`claim_pending: ${error.message}`);
    const rows = (data ?? []) as PendingRow[];
    if (!rows.length) break;
    for (let i = 0; i < rows.length; i++) {
      if (deadline.remainingMs() <= PER_MESSAGE_BUDGET_MS) {
        // out of time: give the rest back untouched (no attempt consumed)
        for (const r of rows.slice(i)) { await admin.rpc("release_pending_claim", { p_id: r.id, p_claim_token: r.claim_token }); out.released++; }
        return out;
      }
      const ok = await processOne(rows[i]);
      if (ok) out.processed++; else out.deferred++;
    }
    left -= rows.length;
    if (rows.length < n) break;
  }
  return out;
}

// Called right after a send so the common case is fast; the cron tick retries anything missed.
export async function processPendingById(id: string) {
  const admin = supabaseAdmin();
  const { data } = await admin.rpc("claim_pending_by_id", { p_id: id, p_lease_seconds: CLAIM_LEASE_SECONDS });
  const row = ((data ?? []) as PendingRow[])[0];
  if (!row) return;
  await processOne(row);
}

async function processOne(row: PendingRow): Promise<boolean> {
  const admin = supabaseAdmin();
  try {
    // Minimal context: last 8 approved messages, sender-relative, never stored by the gateway.
    const { data: recentRows } = await admin
      .from("approved_messages")
      .select("sender_participant_id, body")
      .eq("conversation_id", row.conversation_id)
      .order("created_at", { ascending: false })
      .limit(8);
    const recent = (recentRows ?? []).reverse().map((m) => ({ fromSender: m.sender_participant_id === row.sender_participant_id, body: m.body }));
    const detectorHits = runDetectors(row.body, recent.filter((r) => r.fromSender).map((r) => r.body));

    const result = await moderate({ body: row.body, kind: row.kind, recent, detectorHits });

    const { data: outcome, error } = await admin.rpc("apply_moderation_decision", {
      p_pending: row.id,
      p_decision: result.decision,
      p_categories: result.categories,
      p_user_explanation: result.user_explanation,
      p_suggested_revision: result.suggested_revision,
      p_confidence: result.confidence,
      p_detector_hits: result.detectorHits,
      p_provider: result.provider,
      p_model: result.model,
      p_raw_valid: result.rawValid,
      p_latency_ms: result.latencyMs,
      p_claim_token: row.claim_token,
    });
    if (error) throw new Error(`apply_moderation_decision: ${error.message}`);

    const o = (outcome ?? {}) as { question_due?: boolean; revealed?: boolean; skipped?: boolean };
    if (o.skipped) return true; // stale claim or state changed meanwhile: the newer outcome stands
    if (o.question_due) await generateNextQuestion(row.conversation_id, "mid");
    if (o.revealed) await advanceAfterReveal(row.conversation_id);
    return true;
  } catch (e) {
    const msg = e instanceof GatewayError ? e.message : `worker: ${(e as Error).message}`;
    if (e instanceof GatewayError && e.refusal) {
      // The model would not assess this content at all. Retrying won't change that: hold it for a person.
      console.warn(`[moderation] holding ${row.id} for review: ${msg}`);
      await admin.rpc("apply_moderation_decision", {
        p_pending: row.id, p_decision: "review", p_categories: ["model_refusal"],
        p_user_explanation: "Automated review couldn't assess this message, so it's held for a human reviewer.",
        p_suggested_revision: null, p_confidence: 0, p_detector_hits: [], p_provider: "anthropic", p_model: null, p_raw_valid: false, p_latency_ms: null,
        p_claim_token: row.claim_token,
      });
      return false;
    }
    console.warn(`[moderation] deferring ${row.id}: ${msg}`);
    await admin.rpc("defer_pending", { p_pending: row.id, p_error: msg, p_max_attempts: 6, p_claim_token: row.claim_token });
    return false;
  }
}

// After an opening-round question is revealed, ask the next one (or the
// conversation has moved to 'chatting' inside maybe_reveal_question).
export async function advanceAfterReveal(conversationId: string) {
  const admin = supabaseAdmin();
  const { data: conv } = await admin.from("conversations").select("status, questions_asked, opening_question_count").eq("id", conversationId).single();
  if (!conv) return;
  if (conv.status === "opening" && conv.questions_asked < conv.opening_question_count) {
    const { data: open } = await admin.from("conversation_questions").select("id").eq("conversation_id", conversationId).eq("status", "open").limit(1);
    if (!open?.length) await generateNextQuestion(conversationId, "opening");
  }
}
