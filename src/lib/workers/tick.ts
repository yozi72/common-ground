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

async function hasQuestionWork(admin: ReturnType<typeof supabaseAdmin>) {
  const [{ count: fresh }, { data: due }] = await Promise.all([
    admin.from("conversations").select("id", { count: "exact", head: true }).eq("status", "opening").eq("questions_asked", 0),
    admin.rpc("conversations_due_for_question", { p_limit: 1 }),
  ]);
  if ((fresh ?? 0) > 0 || (due ?? []).length > 0) return true;
  // opening rounds whose revealed question has no successor yet
  const { data: stuck } = await admin.from("conversations").select("id").eq("status", "opening").gt("questions_asked", 0).limit(20);
  for (const c of stuck ?? []) {
    const { data: open } = await admin.from("conversation_questions").select("id").eq("conversation_id", c.id).eq("status", "open").limit(1);
    if (!open?.length) return true;
  }
  return false;
}
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
  await stage("reminders", () => sendDueReminders(Date.now(), deadline));
  await stage("email", () => sendQueuedEmails(20, deadline));
  await stage("friendPush", () => sendFriendMessagePushes(20, {}, deadline));

  // Fair scheduling: when questions are waiting (opening rounds without a question,
  // revealed rounds without the next one, due mid-questions), moderation leaves
  // enough of the budget for one generation so a backlog cannot starve them.
  // The reserve is at most half of what is left, so a short (25 s) fallback tick still moderates something.
  const questionWork = await hasQuestionWork(admin);
  const reserve = questionWork ? Math.min(QUESTION_BUDGET_MS + 6_000, Math.floor(deadline.remainingMs() / 2)) : 0;
  await stage("moderation", () => processPendingBatch(20, reserve ? deadline.minus(reserve) : deadline), 6000);

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
  }, 8_000);   // a bank/mock generation is instant; a model generation bounds itself to the budget it is handed

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
