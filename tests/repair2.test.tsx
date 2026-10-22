// Finishing fixes: appeal outcomes in open/cleared chats, budget-deferred rows
// and polling, never-started reminder/outbox releases, scheduling fairness
// across consecutive ticks. Local stack, intercepted providers and senders.
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { setModelClientForTests, type ModelRequest } from "@/lib/ai/gateway";
import { processPendingBatch } from "@/lib/workers/moderation";
import { generateNextQuestion } from "@/lib/workers/questions";
import { sendDueReminders } from "@/lib/workers/reminders";
import { sendQueuedEmails } from "@/lib/workers/email";
import { runTick } from "@/lib/workers/tick";
import { Deadline } from "@/lib/workers/deadline";
import { getScheduleConfig } from "@/lib/schedule-config";
import { nextSessions } from "@/lib/schedule";
import { fastPollDue, type HeldMessage } from "@/lib/held-messages";
import { admin, makeUser, deleteUser, openSessionNow, openConversation, finishOpeningRound, resetQueue, LEFT, RIGHT, type TestUser } from "./helpers";

const made: TestUser[] = [];
afterAll(async () => { for (const u of made.splice(0)) await deleteUser(u); });
const setCfg = (key: string, value: unknown) => admin().from("policy_config").upsert({ key, value: value as never });
async function chatting(tag: string) {
  await openSessionNow(); await resetQueue();
  const a = await makeUser(`${tag}-a`, LEFT); const b = await makeUser(`${tag}-b`, RIGHT); made.push(a, b);
  const conv = await openConversation(a, b);
  expect(await finishOpeningRound(a, b, conv, generateNextQuestion)).toBe("chatting");
  return { a, b, conv };
}
async function keepTalking(tag: string) {
  const { a, b, conv } = await chatting(tag);
  await a.client.rpc("leave_conversation", { p_conversation: conv });
  await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
  await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
  const { data: conns } = await a.client.rpc("friend_threads_overview");
  const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
  return { a, b, conv, connectionId: conns![0].connection_id as string, tid: tid as string };
}
async function held(u: TestUser, conv: string, id: string, body = "my number is 415 555 0199") {
  const { data: pid, error } = await u.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: id, p_body: body });
  expect(error).toBeNull();
  await processPendingBatch();
  return pid as string;
}
const heldFor = async (u: TestUser, conv: string) => ((await u.client.rpc("my_held_messages", { p_conversation: conv })).data ?? []) as HeldMessage[];

describe("1. appeals in open and cleared chats", () => {
  it("an open chat cleared by the other participant: the appeal, its overturn and the honest outcome stay visible in the still-open chat; nothing is resurrected", async () => {
    const { a, b, tid } = await keepTalking("oc1");
    const pid = await held(a, tid, "oc1-1");
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "oc1-ok", p_body: "plain words" });
    await processPendingBatch();
    expect((await admin().from("approved_messages").select("id").eq("conversation_id", tid)).data).toHaveLength(1);
    await b.client.rpc("clear_thread_history", { p_conversation: tid });               // the OTHER person clears
    expect((await admin().from("approved_messages").select("id").eq("conversation_id", tid)).data).toEqual([]);
    const { data: appeal } = await a.client.rpc("file_appeal", { p_pending: pid, p_note: "mine" });
    let mine = await heldFor(a, tid);                                                  // reload: the persisted appeal is there
    expect(mine[0]).toMatchObject({ id: pid, status: "revise", appeal_status: "open", appeal_note: "mine" });
    expect((await admin().rpc("resolve_appeal", { p_appeal: appeal, p_status: "overturned", p_note: null, p_resolver: null })).data).toMatchObject({ delivered: false, reason: "cleared" });
    mine = await heldFor(a, tid);                                                      // the chat is still open and the row still listed
    expect((await admin().from("conversations").select("status").eq("id", tid).single()).data!.status).toBe("chatting");
    expect(mine[0]).toMatchObject({ status: "cancelled", appeal_status: "overturned", undeliverable_reason: "cleared" });
    expect(mine[0].user_explanation).toMatch(/history was cleared/);
    expect((await admin().from("approved_messages").select("id").eq("conversation_id", tid)).data).toEqual([]);   // no delivery, nothing resurrected
    expect(await heldFor(b, tid)).toEqual([]);                                         // never the other participant's
    // accepting the revision of a cancelled row is refused too
    expect((await a.client.rpc("accept_revision", { p_pending: pid })).error).toBeTruthy();
  });
});

describe("2. budget-deferred messages do not keep the screen fast-polling", () => {
  const calls: ModelRequest[] = [];
  afterEach(async () => { setModelClientForTests(null); process.env.AI_PROVIDER = "mock"; delete process.env.ANTHROPIC_API_KEY; await setCfg("model_calls_per_day_per_account", 0); });
  it("a deferred row has a far retry time (no fast poll), an ordinary one polls, both together poll, and eligibility returns", async () => {
    process.env.AI_PROVIDER = "anthropic"; process.env.ANTHROPIC_API_KEY = "test-only";
    setModelClientForTests(async (req) => { calls.push(req); return { text: JSON.stringify({ decision: "allow", categories: [], user_explanation: null, suggested_revision: null, confidence: 0.9 }), model: "x" }; });
    await setCfg("model_calls_per_day_per_account", 1);
    const { a, conv } = await chatting("bd1");
    await admin().from("model_usage").delete().eq("account_id", a.id);
    await admin().from("pending_messages").update({ status: "cancelled", last_error: "test cleanup" }).eq("status", "pending");
    const { data: p1 } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "bd-1", p_body: "one" });
    const { data: p2 } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "bd-2", p_body: "two" });
    expect(await processPendingBatch()).toMatchObject({ processed: 1, budgetDeferred: 1 });
    const rows = async () => (await a.client.from("pending_messages").select("id, status, next_attempt_at").in("id", [p1, p2])).data!;   // what the screen loads, under RLS
    let r = await rows();
    const deferred = r.find((x) => x.id === p2)!;
    expect(deferred.status).toBe("pending");
    expect(fastPollDue([deferred], Date.now())).toBe(false);                            // deferred until the reset: no 1.5 s polling
    const { data: p3 } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "bd-3", p_body: "three" });
    const fresh = (await a.client.from("pending_messages").select("id, status, next_attempt_at").eq("id", p3!).single()).data!;
    expect(fastPollDue([fresh], Date.now())).toBe(true);                                // an ordinary pending row polls
    expect(fastPollDue([deferred, fresh], Date.now())).toBe(true);                      // both together poll (for the live one)
    await admin().from("pending_messages").update({ status: "cancelled" }).eq("id", p3!);
    // eligibility returns: the worker made it due again (reset) → fast polling resumes and it gets delivered
    await admin().from("model_usage").delete().eq("account_id", a.id);
    await admin().from("pending_messages").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", p2!);
    r = await rows();
    expect(fastPollDue([r.find((x) => x.id === p2)!], Date.now())).toBe(true);
    expect((await processPendingBatch()).processed).toBe(1);
    expect((await admin().from("pending_messages").select("status").eq("id", p2!).single()).data!.status).toBe("approved");
  });
});

describe("3. reminder and outbox claims are released when the provider call never started", () => {
  async function prefs(tag: string, devices: number, email: boolean) {
    await openSessionNow();
    const u = await makeUser(tag, LEFT); made.push(u);
    await u.client.from("reminder_prefs").upsert({ account_id: u.id, push_enabled: devices > 0, email_enabled: email, mode: "daily", days: [0, 1, 2, 3, 4, 5, 6], minutes_before: 10 });
    for (let i = 1; i <= devices; i++) await u.client.rpc("upsert_push_subscription", { p_endpoint: `https://fcm.googleapis.com/fcm/send/${tag}-${i}-${u.id}`, p_p256dh: "BPdummykeydummykeydummykey", p_auth: "authdummy", p_user_agent: "test" });
    const cfg = await getScheduleConfig();
    const at = nextSessions(Date.now() + 3 * 3600_000, 1, cfg)[0].start - 9 * 60_000;
    return { u, at };
  }
  const sends = async (u: TestUser) => (await admin().from("reminder_sends").select("channel, status, attempts, last_error").eq("account_id", u.id)).data!;
  // other accounts' reminders would consume the fake clock; keep the pref set to this test's accounts
  const quiet = () => admin().from("reminder_prefs").update({ push_enabled: false, email_enabled: false }).or("push_enabled.eq.true,email_enabled.eq.true");

  // Every clock read moves 4.2 s of a 12 s budget: the pre-claim check (3rd read) still sees 3.6 s,
  // the claim and the address lookup happen, and within()'s own read (4th) finds the budget gone.
  const jumpy = () => { const base = Date.now(); let k = 0; return () => base + (++k) * 4_200; };

  it("deadline exhausted after the claim and during the address lookup: zero provider calls, no attempt consumed, claim gone", async () => {
    await quiet();
    const { u, at } = await prefs("rl1", 0, true);
    let pushCalls = 0, emailCalls = 0;
    const r = await sendDueReminders(at, Deadline.in(12_000, jumpy()), { pushConfigured: true, emailConfigured: true, sendPush: async () => { pushCalls++; }, sendEmail: async () => { emailCalls++; } });
    expect(pushCalls + emailCalls).toBe(0);
    expect(r.email.released).toBe(1);
    expect(r.push.failed + r.email.failed).toBe(0);
    expect(await sends(u)).toEqual([]);                                               // released claims leave no row (nothing to retry, nothing consumed)
    // next run with time: the email goes out, once
    const r2 = await sendDueReminders(at, Deadline.none(), { pushConfigured: true, emailConfigured: true, sendPush: async () => { pushCalls++; }, sendEmail: async () => { emailCalls++; } });
    expect(r2.email.sent).toBe(1);
    expect(pushCalls).toBe(0); expect(emailCalls).toBe(1);
    expect((await sends(u))[0]).toMatchObject({ channel: "email", status: "sent", attempts: 1 });
  });

  it("a release restores a previously failed send's attempt count; a started send that times out counts as uncertain; overlapping workers send once", async () => {
    await quiet();
    const { u, at } = await prefs("rl2", 1, false);
    // genuine failure first: attempts 1, status failed
    const r1 = await sendDueReminders(at, Deadline.none(), { pushConfigured: true, emailConfigured: false, sendPush: async () => { throw Object.assign(new Error("boom"), { statusCode: 500 }); } });
    expect(r1.push.failed).toBe(1);
    expect((await sends(u))[0]).toMatchObject({ status: "failed", attempts: 1 });
    // re-claim (attempts 2) then no time before the provider call: back to failed with attempts 1
    let calls = 0;
    const r2 = await sendDueReminders(at, Deadline.in(12_000, jumpy()), { pushConfigured: true, emailConfigured: false, sendPush: async () => { calls++; } });
    expect(calls).toBe(0);
    expect(r2.push.released).toBe(1);
    expect((await sends(u))[0]).toMatchObject({ status: "failed", attempts: 1 });
    // started send that never answers: uncertain, attempt consumed (2), still retryable
    const b2 = Date.now(); let el = 0;
    const r3 = await sendDueReminders(at, Deadline.in(3_500, () => b2 + el), { pushConfigured: true, emailConfigured: false, sendPush: async () => { el += 20_000; return new Promise<void>(() => undefined); } });   // within()'s timer fires after 3.5 s
    expect(r3.push.failed).toBe(1);
    const s3 = (await sends(u))[0];
    expect(s3).toMatchObject({ status: "failed", attempts: 2 });
    expect(s3.last_error).toMatch(/delivery uncertain/);
    // overlapping workers: one send, the other finds the claim taken
    let sent = 0;
    const [x, y] = await Promise.all([
      sendDueReminders(at, Deadline.none(), { pushConfigured: true, emailConfigured: false, sendPush: async () => { sent++; await new Promise((res) => setTimeout(res, 200)); } }),
      sendDueReminders(at, Deadline.none(), { pushConfigured: true, emailConfigured: false, sendPush: async () => { sent++; await new Promise((res) => setTimeout(res, 200)); } }),
    ]);
    expect(x.push.sent + y.push.sent).toBe(1);
    expect(sent).toBe(1);
    expect((await sends(u))[0]).toMatchObject({ status: "sent", attempts: 3 });
  });

  it("outbox: the budget running out after the claim and relevance check releases the row without an attempt or a provider call", async () => {
    await admin().from("email_outbox").update({ status: "cancelled", last_error: "test cleanup" }).in("status", ["queued", "claimed"]);
    await openSessionNow(); await resetQueue();
    const a = await makeUser("ob-a", LEFT); const b = await makeUser("ob-b", RIGHT); made.push(a, b);
    await a.client.rpc("join_queue", { p_notify_email: true }); await b.client.rpc("join_queue", { p_notify_email: true });
    expect((await admin().rpc("run_matching")).data).toBe(1);
    const base = Date.now(); let reads = 0; let calls = 0;
    // enough budget to claim one row and pass the recheck; the clock jumps before the deliverer would be invoked
    const r = await sendQueuedEmails(20, Deadline.in(6_000, () => (reads++ < 4 ? base : base + 60_000)), { configured: true, deliver: async () => { calls++; return "fake"; } });
    expect(calls).toBe(0);
    expect(r.sent).toBe(0); expect(r.retried).toBe(0);
    expect(r.released).toBeGreaterThanOrEqual(1);
    const { data: rows } = await admin().from("email_outbox").select("status, attempts").in("account_id", [a.id, b.id]);
    expect(rows!.every((x) => x.status === "queued" && x.attempts === 0)).toBe(true);
  });
});

describe("4. question scheduling is fair across consecutive ticks", () => {
  const mk = (status: string, asked: number, extra: Record<string, unknown>) => ({ kind: "live", status, questions_asked: asked, opening_question_count: 10, question_gap_seconds: 60, active_seconds_since_question: 0, opened_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), ...extra });
  afterEach(() => { setModelClientForTests(null); process.env.AI_PROVIDER = "mock"; delete process.env.ANTHROPIC_API_KEY; });

  for (const budget of [25_000, 48_000]) {
    it(`with ${budget / 1000} s ticks, slow generation, new first questions every tick and a chatty mid conversation, successors and mid questions are created within three runs`, async () => {
      process.env.AI_PROVIDER = "anthropic"; process.env.ANTHROPIC_API_KEY = "test-only";
      let n = 0;
      setModelClientForTests(async (req) => { n++; await new Promise((r) => setTimeout(r, 2_500)); return { text: JSON.stringify(req.system.includes("facilitate") ? { shared_question: `What made a day easier recently? (${n})`, choices: ["A", "B", "C"], optional_followup_a: null, optional_followup_b: null, rationale_internal: "t", sensitive_topic_flag: false } : { decision: "allow", categories: [], user_explanation: null, suggested_revision: null, confidence: 0.9 }), model: "x" }; });
      await admin().from("conversations").update({ status: "ended", ended_at: new Date().toISOString(), end_reason: "abandoned" }).eq("kind", "live").neq("status", "ended");   // a clean board
      const ids: string[] = [];
      const insert = async (rows: Record<string, unknown>[]) => { const { data } = await admin().from("conversations").insert(rows).select("id"); for (const r of data!) ids.push(r.id); return data!.map((r) => r.id as string); };
      try {
        // a successor that has been waiting 10 minutes and a mid conversation that keeps getting messages
        const [succ] = await insert([mk("opening", 1, { opened_at: new Date(Date.now() - 20 * 60_000).toISOString(), last_activity_at: new Date().toISOString() })]);
        await admin().from("conversation_questions").insert({ conversation_id: succ, seq: 1, phase: "opening", question_text: "q1", choices: ["a", "b", "c"], status: "revealed", revealed_at: new Date(Date.now() - 10 * 60_000).toISOString(), created_at: new Date(Date.now() - 11 * 60_000).toISOString(), source: "bank" });
        const [mid] = await insert([mk("chatting", 3, { active_seconds_since_question: 900, chat_started_at: new Date().toISOString(), opened_at: new Date(Date.now() - 30 * 60_000).toISOString() })]);
        await admin().from("conversation_questions").insert({ conversation_id: mid, seq: 3, phase: "mid", question_text: "q3", choices: ["a", "b", "c"], status: "revealed", revealed_at: new Date(Date.now() - 12 * 60_000).toISOString(), created_at: new Date(Date.now() - 13 * 60_000).toISOString(), source: "bank" });
        let succAsked = 0, midAsked = 0, runs = 0;
        for (let t = 0; t < 3 && (succAsked === 0 || midAsked === 0); t++) {
          await insert(Array.from({ length: 8 }, () => mk("opening", 0, {})));       // a continuing stream of brand-new conversations
          await admin().from("conversations").update({ last_activity_at: new Date().toISOString() }).eq("id", mid);   // the chatty one keeps moving
          const out = await runTick({ budgetMs: budget, source: "fair2" });
          runs++;
          const q = out.questions as { asked: number; advanced: number; mid: number };
          expect(q.asked + q.advanced + q.mid).toBeGreaterThanOrEqual(1);
          succAsked = (await admin().from("conversation_questions").select("id").eq("conversation_id", succ)).data!.length - 1;
          midAsked = (await admin().from("conversation_questions").select("id").eq("conversation_id", mid)).data!.length - 1;
        }
        expect(succAsked, "successor question created").toBeGreaterThanOrEqual(1);
        expect(midAsked, "mid question created").toBeGreaterThanOrEqual(1);
        expect(runs).toBeLessThanOrEqual(3);
      } finally {
        await admin().from("conversations").delete().in("id", ids);
      }
    }, 200_000);
  }
});
