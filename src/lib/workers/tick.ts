// One worker tick: housekeeping, matching, moderation retries, emails.
// Idempotent; safe to run every 15–30 seconds from any scheduler.
import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { processPendingBatch, advanceAfterReveal } from "./moderation";
import { sendQueuedEmails } from "./email";
import { generateNextQuestion } from "./questions";

export async function runTick(opts: { retention?: boolean } = {}) {
  const admin = supabaseAdmin();
  const out: Record<string, unknown> = {};

  const { data: stale, error: e1 } = await admin.rpc("expire_stale");
  out.expire = e1 ? { error: e1.message } : stale;

  const { data: pairs, error: e2 } = await admin.rpc("run_matching");
  out.matching = e2 ? { error: e2.message } : { pairs };

  // Conversations that opened but have no question yet (e.g. generation failed at open time)
  const { data: fresh } = await admin.from("conversations").select("id").eq("status", "opening").eq("questions_asked", 0).limit(20);
  for (const c of fresh ?? []) {
    try { await generateNextQuestion(c.id, "opening"); } catch (e) { console.warn("[tick] question", (e as Error).message); }
  }
  // Opening conversations whose current question was revealed but the next never arrived
  const { data: stuck } = await admin.from("conversations").select("id").eq("status", "opening").gt("questions_asked", 0).limit(50);
  for (const c of stuck ?? []) {
    try { await advanceAfterReveal(c.id); } catch (e) { console.warn("[tick] advance", (e as Error).message); }
  }

  try { out.moderation = await processPendingBatch(20); } catch (e) { out.moderation = { error: (e as Error).message }; }
  try { out.email = await sendQueuedEmails(); } catch (e) { out.email = { error: (e as Error).message }; }

  if (opts.retention) {
    const { data, error } = await admin.rpc("purge_retention");
    out.retention = error ? { error: error.message } : data;
  }
  return out;
}
