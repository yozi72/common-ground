// One worker tick: housekeeping, matching, reminders, emails, pushes, then
// moderation retries and question generation inside what is left of the
// budget. Idempotent; safe to run every minute from any scheduler.
//
// Budget: the route's maxDuration (60 s) minus a safety margin. Cheap, time-
// sensitive stages (reminders, emails, friend pushes) run before the model-
// bound ones so a moderation backlog can never starve them; moderation claims
// only what can start before the deadline and releases the rest; question
// generation gets a reserve measured after the cheap stages and works through
// one ordered, backed-off list (see question_work in migration 0016).
import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { processPendingBatch, advanceAfterReveal } from "./moderation";
import { sendQueuedEmails } from "./email";
import { sendDueReminders } from "./reminders";
import { sendFriendMessagePushes } from "./friend-push";
import { generateNextQuestion } from "./questions";
import { Deadline } from "./deadline";

export const TICK_MAX_DURATION_SECONDS = 60;

// Budget constants (all in ms). A tick needs roughly MODERATION_MIN_MS +
// QUESTION_ITEM_MS + the cheap stages (~20 s) for BOTH moderation and question
// generation to make progress; the cron tick has 48 s, the opportunistic tick 25 s.
const SAFETY_MARGIN_MS = 12_000;
export const QUESTION_ITEM_MS = 8_000;      // smallest budget worth starting one generation (the gateway shortens the call to fit; a miss falls back to the bank)
export const QUESTION_RESERVE_MS = 12_000;  // what moderation leaves for questions when question work exists
const MODERATION_MIN_MS = 8_000;            // moderation keeps at least this much when it has to share

type QuestionWork = { id: string; need: "first" | "successor" | "mid" };
async function questionWork(admin: ReturnType<typeof supabaseAdmin>, limit: number): Promise<QuestionWork[]> {
  const { data, error } = await admin.rpc("question_work", { p_limit: limit });
  if (error) throw new Error(`question_work: ${error.message}`);
  return (data ?? []) as QuestionWork[];
}

// Order comes from question_work (migration 0018): items ranked within their
// kind and ordered by rank, then by a stable waiting anchor, so the one slot a
// short tick can afford goes to the oldest waiting item of any kind. Nothing
// is re-ordered here.

export async function runTick(opts: { retention?: boolean; source?: string; budgetMs?: number; clock?: () => number } = {}) {
  const admin = supabaseAdmin();
  const clock = opts.clock ?? Date.now;
  const deadline = Deadline.in(opts.budgetMs ?? TICK_MAX_DURATION_SECONDS * 1000 - SAFETY_MARGIN_MS, clock);
  const out: Record<string, unknown> = {};
  const stage = async (name: string, fn: () => Promise<unknown>, minMs = 1500) => {
    if (deadline.remainingMs() < minMs) { out[name] = { skipped: "deadline" }; return; }
    try { out[name] = await fn(); } catch (e) { out[name] = { error: (e as Error).message }; }
  };
  // heartbeat row so operators can see the scheduler is alive (Review → Metrics / SQL)
  await admin.from("metric_events").insert({ kind: "worker_tick", meta: { source: opts.source ?? "unknown" } });

  await stage("expire", async () => { const { data, error } = await admin.rpc("expire_stale"); if (error) throw new Error(error.message); return data; });
  await stage("matching", async () => { const { data, error } = await admin.rpc("run_matching"); if (error) throw new Error(error.message); return { pairs: data }; });
  // time-sensitive and cheap: never behind the model-bound stages
  await stage("reminders", () => sendDueReminders(clock(), deadline));
  await stage("email", () => sendQueuedEmails(20, deadline));
  await stage("friendPush", () => sendFriendMessagePushes(20, {}, deadline));

  // Fair scheduling, measured AFTER the cheap stages consumed their time: when
  // question work exists, moderation stops QUESTION_RESERVE_MS before the
  // deadline (never leaving itself less than MODERATION_MIN_MS). The question
  // stage then runs one item at a time while QUESTION_ITEM_MS remains, so both
  // stages progress on every tick long enough for both; a tick shorter than that
  // moderates first (the next tick's reserve catches the questions up).
  const pendingQuestions = await questionWork(admin, 50);
  const reserve = pendingQuestions.length ? Math.max(0, Math.min(QUESTION_RESERVE_MS, deadline.remainingMs() - MODERATION_MIN_MS)) : 0;
  await stage("moderation", () => processPendingBatch(20, reserve ? deadline.minus(reserve) : deadline), 6000);

  await stage("questions", async () => {
    const result = { asked: 0, advanced: 0, mid: 0, failed: 0, deferred: 0 };
    const work = await questionWork(admin, 50);   // re-read: moderation may have revealed or asked some
    for (const w of work) {
      if (deadline.remainingMs() < QUESTION_ITEM_MS) { result.deferred += 1; continue; }
      try {
        if (w.need === "first") { if (await generateNextQuestion(w.id, "opening", { deadlineMs: deadline.remainingMs() - 1000 })) result.asked++; }
        else if (w.need === "successor") { await advanceAfterReveal(w.id, deadline); result.advanced++; }
        else if (await generateNextQuestion(w.id, "mid", { deadlineMs: deadline.remainingMs() - 1000 })) result.mid++;
      } catch (e) {
        // a failing conversation backs off (database) so it cannot monopolize the stage; the failure is a metric event
        result.failed++;
        console.warn("[tick] question", w.need, (e as Error).message);
        await admin.rpc("note_question_failure", { p_conversation: w.id, p_error: (e as Error).message });
      }
    }
    return result;
  }, QUESTION_ITEM_MS);

  if (opts.retention) {
    await stage("retention", async () => { const { data, error } = await admin.rpc("purge_retention"); if (error) throw new Error(error.message); return data; });
  }
  out.remainingMs = deadline.remainingMs();
  return out;
}

// Hosts without minute-level cron (e.g. Vercel's free plan) still get timely
// housekeeping: active clients call this through their heartbeat, and it runs a
// tick at most once per interval per server instance.
let lastOpportunisticTick = 0;
export function maybeTick(minIntervalMs = 20_000) {
  const now = Date.now();
  if (now - lastOpportunisticTick < minIntervalMs) return Promise.resolve(null);
  lastOpportunisticTick = now;
  return runTick({ budgetMs: 25_000 }).catch((e) => { console.warn("[tick] opportunistic", (e as Error).message); return null; });
}
