// One worker tick: housekeeping, matching, reminders, emails, pushes, then
// moderation retries and question generation inside what is left of the
// budget. Idempotent; safe to run every minute from any scheduler.
//
// Budget: the route's maxDuration (60 s) minus a safety margin. Cheap, time-
// sensitive stages (reminders, emails, friend pushes) run before the model-
// bound ones so a moderation backlog can never starve them; moderation claims
// only what can start before the deadline and releases the rest.
import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { processPendingBatch, advanceAfterReveal } from "./moderation";
import { sendQueuedEmails } from "./email";
import { sendDueReminders } from "./reminders";
import { sendFriendMessagePushes } from "./friend-push";
import { generateNextQuestion } from "./questions";
import { Deadline } from "./deadline";

export const TICK_MAX_DURATION_SECONDS = 60;
const SAFETY_MARGIN_MS = 12_000;
const QUESTION_BUDGET_MS = 20_000; // one generation call worst case

export async function runTick(opts: { retention?: boolean; source?: string; budgetMs?: number } = {}) {
  const admin = supabaseAdmin();
  const deadline = Deadline.in(opts.budgetMs ?? TICK_MAX_DURATION_SECONDS * 1000 - SAFETY_MARGIN_MS);
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
  await stage("reminders", () => sendDueReminders());
  await stage("email", () => sendQueuedEmails(20, deadline));
  await stage("friendPush", () => sendFriendMessagePushes());

  await stage("moderation", () => processPendingBatch(20, deadline), 6000);

  // Conversations that opened but have no question yet (e.g. generation failed at open time)
  await stage("questions", async () => {
    let asked = 0, advanced = 0;
    const { data: fresh } = await admin.from("conversations").select("id").eq("status", "opening").eq("questions_asked", 0).limit(20);
    for (const c of fresh ?? []) {
      if (deadline.remainingMs() < QUESTION_BUDGET_MS) break;
      try { await generateNextQuestion(c.id, "opening", { deadlineMs: deadline.remainingMs() - 1000 }); asked++; } catch (e) { console.warn("[tick] question", (e as Error).message); }
    }
    // Opening conversations whose current question was revealed but the next never arrived
    const { data: stuck } = await admin.from("conversations").select("id").eq("status", "opening").gt("questions_asked", 0).limit(50);
    for (const c of stuck ?? []) {
      if (deadline.remainingMs() < QUESTION_BUDGET_MS) break;
      try { await advanceAfterReveal(c.id, deadline); advanced++; } catch (e) { console.warn("[tick] advance", (e as Error).message); }
    }
    // Open chats whose next shared question is due but was never generated
    // (the moderation worker skips follow-ups when it is short on time)
    let mid = 0;
    const { data: due } = await admin.rpc("conversations_due_for_question", { p_limit: 20 });
    for (const id of (due ?? []) as string[]) {
      if (deadline.remainingMs() < QUESTION_BUDGET_MS) break;
      try { if (await generateNextQuestion(id, "mid", { deadlineMs: deadline.remainingMs() - 1000 })) mid++; } catch (e) { console.warn("[tick] mid question", (e as Error).message); }
    }
    return { asked, advanced, mid };
  }, QUESTION_BUDGET_MS);

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
