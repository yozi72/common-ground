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
//
// Deadlines: the remaining budget is passed into every model call (timeout and
// retry count shrink to fit), follow-up question generation only runs when
// there is room for it (the tick's question stage catches the rest), and a
// message whose call cannot start before the deadline is released, not failed.
//
// Contact permission: thread_contact_allowed (database) is the one authority.
// Its value at moderation time is handed to apply_moderation_decision, which
// re-checks it under the conversation lock before delivering.
import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { moderate, GatewayError, MODEL_TIMEOUT_MS } from "@/lib/ai/gateway";
import { runDetectors, hitsAreIdentifying, categoriesAreIdentityOnly } from "@/lib/ai/detectors";
import { generateNextQuestion } from "./questions";
import { Deadline } from "./deadline";

type PendingRow = {
  id: string; conversation_id: string; sender_participant_id: string; kind: "chat" | "answer";
  question_id: string | null; body: string; attempts: number; claim_token: string;
};

export const CLAIM_LEASE_SECONDS = 75;      // ≥ gateway timeout (25 s) × 2 tries + margin
const MIN_START_MS = 6_000;                 // smallest budget worth starting a (shortened) model call
const TYPICAL_MESSAGE_MS = MODEL_TIMEOUT_MS + 5_000;   // used only to size claims
const QUESTION_FOLLOWUP_MS = 15_000;        // room needed to generate a follow-up question inline
const BATCH = 5;                            // claim in small batches so nothing waits on a long lease

export type ModerationDeps = { moderate?: typeof moderate };   // injectable for tests (slow / failing providers)

// Drains everything that is due, in small claims, until the deadline leaves no
// room for another message. `limit` caps one claim; the deadline bounds the run.
export async function processPendingBatch(limit = 10, deadline: Deadline = Deadline.none(), deps: ModerationDeps = {}): Promise<{ processed: number; deferred: number; released: number; budgetDeferred: number }> {
  const admin = supabaseAdmin();
  const out = { processed: 0, deferred: 0, released: 0, budgetDeferred: 0 };
  while (deadline.remainingMs() > MIN_START_MS) {
    // never claim more than can plausibly start before the deadline
    const n = Math.min(BATCH, limit, Math.max(1, Math.floor(deadline.remainingMs() / TYPICAL_MESSAGE_MS)));
    const { data, error } = await admin.rpc("claim_pending", { p_limit: n, p_lease_seconds: CLAIM_LEASE_SECONDS });
    if (error) throw new Error(`claim_pending: ${error.message}`);
    const rows = (data ?? []) as PendingRow[];
    if (!rows.length) break;
    for (let i = 0; i < rows.length; i++) {
      if (deadline.remainingMs() <= MIN_START_MS) {
        // out of time: give the rest back untouched (no attempt consumed)
        for (const r of rows.slice(i)) { await admin.rpc("release_pending_claim", { p_id: r.id, p_claim_token: r.claim_token }); out.released++; }
        return out;
      }
      const r = await processOne(rows[i], deadline, deps);
      if (r === "ok") out.processed++; else if (r === "released") out.released++; else if (r === "budget") out.budgetDeferred++; else out.deferred++;
    }
    if (rows.length < n) break;
  }
  return out;
}

// Called right after a send so the common case is fast; the cron tick retries anything missed.
export async function processPendingById(id: string, deadline: Deadline = Deadline.in(50_000), deps: ModerationDeps = {}) {
  const admin = supabaseAdmin();
  const { data } = await admin.rpc("claim_pending_by_id", { p_id: id, p_lease_seconds: CLAIM_LEASE_SECONDS });
  const row = ((data ?? []) as PendingRow[])[0];
  if (!row) return;
  await processOne(row, deadline, deps);
}

async function processOne(row: PendingRow, deadline: Deadline, deps: ModerationDeps): Promise<"ok" | "deferred" | "released" | "budget"> {
  const admin = supabaseAdmin();
  const mod = deps.moderate ?? moderate;
  try {
    // Minimal context: last 8 approved messages, sender-relative, never stored by the gateway.
    const { data: recentRows } = await admin
      .from("approved_messages")
      .select("sender_participant_id, body")
      .eq("conversation_id", row.conversation_id)
      .order("created_at", { ascending: false })
      .limit(8);
    const recent = (recentRows ?? []).reverse().map((m) => ({ fromSender: m.sender_participant_id === row.sender_participant_id, body: m.body }));
    const { data: conv } = await admin.from("conversations").select("kind").eq("id", row.conversation_id).maybeSingle();
    const isThread = conv?.kind === "friend";
    // one authority for contact permission (friends tier, active, unblocked)
    const { data: allowed, error: allowedErr } = isThread ? await admin.rpc("thread_contact_allowed", { p_conversation: row.conversation_id }) : { data: false, error: null };
    if (allowedErr) throw new Error(`thread_contact_allowed: ${allowedErr.message}`);
    const contactAllowed = allowed === true;
    const detectorHits = runDetectors(row.body, recent.filter((r) => r.fromSender).map((r) => r.body));
    // usage attribution: the sender (internal metadata for per-account limits; never in the prompt)
    const { data: senderRow } = await admin.from("participants").select("account_id").eq("id", row.sender_participant_id).maybeSingle();
    const accounts = senderRow?.account_id ? [senderRow.account_id as string] : [];

    const result = await mod({ body: row.body, kind: row.kind, recent, detectorHits, contactAllowed }, { deadlineMs: deadline.remainingMs() - 1000, accounts });
    // In a continuing chat, a held message about the sender's own contact details gets
    // the way to unlock sharing. Never for blocks, holds, or anything beyond identity.
    if (isThread && !contactAllowed && result.decision === "revise" && categoriesAreIdentityOnly(result.categories) && hitsAreIdentifying(result.detectorHits)) {
      result.user_explanation = `${result.user_explanation ?? "This looks like it contains contact or identifying details."} Contact details can be shared once you both choose “Become friends” in this chat.`;
    }

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
      p_contact_allowed: contactAllowed,
    });
    if (error) throw new Error(`apply_moderation_decision: ${error.message}`);

    const o = (outcome ?? {}) as { question_due?: boolean; revealed?: boolean; skipped?: boolean; reason?: string };
    if (o.skipped) return "ok"; // stale claim, cleared history, or permission changed (re-moderated on the next claim)
    // follow-ups only when there is time; otherwise the tick's question stage picks them up
    if (deadline.remainingMs() > QUESTION_FOLLOWUP_MS) {
      if (o.question_due) await generateNextQuestion(row.conversation_id, "mid", { deadlineMs: deadline.remainingMs() - 1000 });
      if (o.revealed) await advanceAfterReveal(row.conversation_id, deadline);
    }
    return "ok";
  } catch (e) {
    const msg = e instanceof GatewayError ? e.message : `worker: ${(e as Error).message}`;
    if (e instanceof GatewayError && e.outOfTime) {
      // our deadline, not the provider's fault: hand the claim back without consuming the attempt
      await admin.rpc("release_pending_claim", { p_id: row.id, p_claim_token: row.claim_token });
      return "released";
    }
    if (e instanceof GatewayError && e.budgetExhausted) {
      // a usage cap, not an outage: keep the message, give the attempt back, explain the wait, and
      // make it claimable again only when the daily usage window resets (no rapid re-claims)
      const { data: resetAt } = await admin.rpc("model_budget_reset_at");
      await admin.rpc("defer_pending_until", { p_pending: row.id, p_until: (resetAt as string | null) ?? new Date(Date.now() + 3600_000).toISOString(), p_error: msg, p_claim_token: row.claim_token });
      return "budget";
    }
    if (e instanceof GatewayError && e.refusal) {
      // The model would not assess this content at all. Retrying won't change that: hold it for a person.
      console.warn(`[moderation] holding ${row.id} for review: ${msg}`);
      await admin.rpc("apply_moderation_decision", {
        p_pending: row.id, p_decision: "review", p_categories: ["model_refusal"],
        p_user_explanation: "Automated review couldn't assess this message, so it's held for a human reviewer.",
        p_suggested_revision: null, p_confidence: 0, p_detector_hits: [], p_provider: "anthropic", p_model: null, p_raw_valid: false, p_latency_ms: null,
        p_claim_token: row.claim_token,
      });
      return "deferred";
    }
    console.warn(`[moderation] deferring ${row.id}: ${msg}`);
    await admin.rpc("defer_pending", { p_pending: row.id, p_error: msg, p_max_attempts: 6, p_claim_token: row.claim_token });
    return "deferred";
  }
}

// After an opening-round question is revealed, ask the next one (or the
// conversation has moved to 'chatting' inside maybe_reveal_question).
export async function advanceAfterReveal(conversationId: string, deadline: Deadline = Deadline.none()) {
  const admin = supabaseAdmin();
  const { data: conv } = await admin.from("conversations").select("status, questions_asked, opening_question_count").eq("id", conversationId).single();
  if (!conv) return;
  if (conv.status === "opening" && conv.questions_asked < conv.opening_question_count) {
    const { data: open } = await admin.from("conversation_questions").select("id").eq("conversation_id", conversationId).eq("status", "open").limit(1);
    if (!open?.length) await generateNextQuestion(conversationId, "opening", { deadlineMs: deadline.remainingMs() - 1000 });
  }
}
