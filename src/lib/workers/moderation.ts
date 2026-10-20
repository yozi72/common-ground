// Moderation worker. Claims pending messages with the service role, calls the
// gateway, and enforces the decision through apply_moderation_decision — the
// only path that writes approved_messages. Any failure defers the message;
// nothing is ever passed on error.
import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { moderate, GatewayError } from "@/lib/ai/gateway";
import { runDetectors } from "@/lib/ai/detectors";
import { generateNextQuestion } from "./questions";

type PendingRow = {
  id: string; conversation_id: string; sender_participant_id: string; kind: "chat" | "answer";
  question_id: string | null; body: string; attempts: number;
};

export async function processPendingBatch(limit = 10): Promise<{ processed: number; deferred: number }> {
  const admin = supabaseAdmin();
  // Deferred rows get a future next_attempt_at, so looping until a batch comes back empty terminates.
  let processed = 0, deferred = 0;
  for (;;) {
    const r = await claimAndProcess(admin, limit);
    processed += r.processed; deferred += r.deferred;
    if (r.processed + r.deferred < limit) break;
  }
  return { processed, deferred };
}

async function claimAndProcess(admin: ReturnType<typeof supabaseAdmin>, limit: number) {
  const { data, error } = await admin.rpc("claim_pending", { p_limit: limit });
  if (error) throw new Error(`claim_pending: ${error.message}`);
  const rows = (data ?? []) as PendingRow[];
  let processed = 0, deferred = 0;
  for (const row of rows) {
    const ok = await processOne(row);
    if (ok) processed++; else deferred++;
  }
  return { processed, deferred };
}

// Called right after a send so the common case is fast; the cron tick retries anything missed.
export async function processPendingById(id: string) {
  const admin = supabaseAdmin();
  // claim just this one if it is still pending and due
  const { data } = await admin
    .from("pending_messages")
    .update({ attempts: 1, next_attempt_at: new Date(Date.now() + 20_000).toISOString() })
    .eq("id", id).eq("status", "pending").eq("attempts", 0)
    .select("id, conversation_id, sender_participant_id, kind, question_id, body, attempts")
    .maybeSingle();
  if (!data) return;
  await processOne(data as PendingRow);
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
    });
    if (error) throw new Error(`apply_moderation_decision: ${error.message}`);

    const o = (outcome ?? {}) as { question_due?: boolean; revealed?: boolean };
    if (o.question_due) await generateNextQuestion(row.conversation_id, "mid");
    if (o.revealed) await advanceAfterReveal(row.conversation_id);
    return true;
  } catch (e) {
    const msg = e instanceof GatewayError ? e.message : `worker: ${(e as Error).message}`;
    console.warn(`[moderation] deferring ${row.id}: ${msg}`);
    await admin.rpc("defer_pending", { p_pending: row.id, p_error: msg, p_max_attempts: 6 });
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
