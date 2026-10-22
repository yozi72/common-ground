// Repair release (reviews of 8390c88 / 0016): items 1–6 end to end against the
// local stack, with intercepted providers and senders (no network).
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setModelClientForTests, type ModelRequest } from "@/lib/ai/gateway";
import { processPendingBatch, advanceAfterReveal } from "@/lib/workers/moderation";
import { generateNextQuestion } from "@/lib/workers/questions";
import { sendFriendMessagePushes } from "@/lib/workers/friend-push";
import { sendQueuedEmails } from "@/lib/workers/email";
import { runTick } from "@/lib/workers/tick";
import { Deadline } from "@/lib/workers/deadline";
import { appealOutcome, undeliverableText, canAcceptRevision, type HeldMessage } from "@/lib/held-messages";
import { admin, makeUser, deleteUser, openSessionNow, openConversation, finishOpeningRound, resetQueue, LEFT, RIGHT, type TestUser } from "./helpers";

const made: TestUser[] = [];
afterAll(async () => { for (const u of made.splice(0)) await deleteUser(u); });
const setCfg = (key: string, value: unknown) => admin().from("policy_config").upsert({ key, value: value as never });
async function pair(tag: string) {
  await openSessionNow(); await resetQueue();
  const a = await makeUser(`${tag}-a`, LEFT); const b = await makeUser(`${tag}-b`, RIGHT); made.push(a, b);
  const conv = await openConversation(a, b);
  return { a, b, conv };
}
async function chatting(tag: string) {
  const { a, b, conv } = await pair(tag);
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
const pending = async (id: string) => (await admin().from("pending_messages").select("status, undeliverable_reason, user_explanation, attempts, next_attempt_at, last_error").eq("id", id).single()).data!;

describe("1. question route: conversation derived from the authorized question; deadlines", () => {
  it("an outsider cannot answer, a participant's question resolves to its own conversation only, and a zero budget still recovers", async () => {
    const { a, b, conv } = await pair("qr1");
    const { a: x } = await pair("qr2");                        // another pair: x is an outsider to conv
    const qid = await generateNextQuestion(conv, "opening");
    expect((await x.client.rpc("answer_with_choice", { p_question: qid, p_choice: 0 })).error?.code).toBe("42501");
    // what the route reads under RLS: a participant sees the conversation, an outsider sees nothing (no privileged work for it)
    expect((await a.client.from("conversation_questions").select("conversation_id").eq("id", qid!).maybeSingle()).data?.conversation_id).toBe(conv);
    expect((await x.client.from("conversation_questions").select("conversation_id").eq("id", qid!).maybeSingle()).data).toBeNull();
    await a.client.rpc("answer_with_choice", { p_question: qid, p_choice: 0 });
    const { data: r } = await b.client.rpc("answer_with_choice", { p_question: qid, p_choice: 1 });
    expect(r.revealed).toBe(true);
    // the follow-up with no budget left: the bank answers instantly (no provider call possible), the round still advances
    await advanceAfterReveal(conv, Deadline.in(0));
    expect((await admin().from("conversations").select("questions_asked").eq("id", conv).single()).data!.questions_asked).toBe(2);
    // and if the follow-up never ran at all, the tick's question stage lists it as a successor
    const q2 = (await admin().from("conversation_questions").select("id").eq("conversation_id", conv).eq("status", "open").single()).data!.id;
    await a.client.rpc("answer_with_choice", { p_question: q2, p_choice: 0 }); await b.client.rpc("answer_with_choice", { p_question: q2, p_choice: 0 });
    const { data: work } = await admin().rpc("question_work", { p_limit: 50 });
    expect((work as { id: string; need: string }[]).some((w) => w.id === conv && w.need === "successor")).toBe(true);
    const t = await runTick({ budgetMs: 25_000, source: "repair-test" });
    expect((t.questions as { advanced: number }).advanced).toBeGreaterThanOrEqual(1);
    expect((await admin().from("conversations").select("questions_asked").eq("id", conv).single()).data!.questions_asked).toBe(3);
  });
});

describe("2. held messages and appeal outcomes stay reachable", () => {
  it("live conversation: leave → find held message → appeal → overturn → outcome visible; never delivered", async () => {
    const { a, b, conv } = await chatting("hm1");
    const pid = await held(a, conv, "hm1-1");
    await b.client.rpc("leave_conversation", { p_conversation: conv });
    let mine = await heldFor(a, conv);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: pid, status: "revise", undeliverable_reason: "left", appeal_id: null });
    expect(await heldFor(b, conv)).toEqual([]);                                  // the other participant never sees them
    expect(appealOutcome(mine[0])).toEqual({ state: "none", canAppeal: true });
    expect(canAcceptRevision(mine[0])).toBe(false);
    const { data: appeal, error } = await a.client.rpc("file_appeal", { p_pending: pid, p_note: "please look again" });
    expect(error).toBeNull();
    mine = await heldFor(a, conv);
    expect(mine[0]).toMatchObject({ appeal_id: appeal, appeal_status: "open", appeal_note: "please look again" });
    expect(appealOutcome(mine[0]).state).toBe("open");
    await admin().rpc("resolve_appeal", { p_appeal: appeal, p_status: "overturned", p_note: "fair point", p_resolver: null });
    mine = await heldFor(a, conv);
    expect(mine).toHaveLength(1);                                                // cancelled-after-appeal rows stay listed
    expect(mine[0]).toMatchObject({ status: "cancelled", appeal_status: "overturned", appeal_resolution_note: "fair point" });
    const o = appealOutcome(mine[0]);
    expect(o).toMatchObject({ state: "overturned", delivered: false });
    expect((o as { explanation: string }).explanation).toMatch(/could not be delivered because the conversation ended/);
    expect((await admin().from("approved_messages").select("id").eq("conversation_id", conv)).data).toEqual([]);
    // rendered: the component lists it with the outcome and no accept button (react-dom/server, initial rows)
    const { HeldMessages } = await import("@/components/HeldMessages");
    const html = renderToStaticMarkup(<HeldMessages conversationId={conv} initial={mine} />);
    expect(html).toContain("could not be delivered because the conversation ended");
    expect(html).not.toContain("Send this version");
    expect(html).not.toContain("Send appeal");
  });

  it("the other person cleared the chat: the recorded reason is the clear, not a generic 'ended'; blocked and upheld outcomes", async () => {
    const { a, b, tid } = await keepTalking("hm2");
    const pid = await held(a, tid, "hm2-1");
    await b.client.rpc("clear_thread_history", { p_conversation: tid });          // b's clear does not mark a's row...
    expect((await pending(pid)).undeliverable_reason).toBeNull();
    const { data: appeal } = await a.client.rpc("file_appeal", { p_pending: pid, p_note: "" });
    const { data: r } = await admin().rpc("resolve_appeal", { p_appeal: appeal, p_status: "overturned", p_note: null, p_resolver: null });
    expect(r).toMatchObject({ delivered: false, reason: "cleared" });            // ...but delivery is refused and the reason says why
    const row = await pending(pid);
    expect(row.undeliverable_reason).toBe("cleared");
    expect(row.user_explanation).toMatch(/history was cleared/);
    expect(undeliverableText("cleared")).toMatch(/history was cleared/);
    expect(undeliverableText("left")).toMatch(/conversation has ended/);
    expect((await admin().from("approved_messages").select("id").eq("conversation_id", tid)).data).toEqual([]);
    // blocked + upheld
    const { a: c, b: d, conv: conv2 } = await chatting("hm3");
    const pid2 = await held(c, conv2, "hm3-1", "kill yourself");
    await d.client.rpc("block_peer", { p_conversation: conv2 });
    const { data: ap2 } = await c.client.rpc("file_appeal", { p_pending: pid2, p_note: "" });
    await admin().rpc("resolve_appeal", { p_appeal: ap2, p_status: "upheld", p_note: "stands", p_resolver: null });
    const mine = await heldFor(c, conv2);
    expect(mine[0]).toMatchObject({ status: "blocked", undeliverable_reason: "blocked", appeal_status: "upheld" });
    expect(appealOutcome(mine[0])).toMatchObject({ state: "upheld", resolutionNote: "stands" });
    // a second appeal on the same message is refused by the server (one open/resolved appeal per message)
    expect((await c.client.rpc("file_appeal", { p_pending: pid2, p_note: "again" })).error).toBeTruthy();
  });
});

describe("3. push: partial failures, uncertain sends, bounded retries", () => {
  async function queued(tag: string, devices: number) {
    const { a, b, tid } = await keepTalking(tag);
    await admin().from("push_queue").update({ status: "cancelled", last_error: "test cleanup" }).in("status", ["queued", "claimed"]);
    await b.client.from("reminder_prefs").upsert({ account_id: b.id, friend_push_enabled: true });
    const subs: string[] = [];
    for (let i = 1; i <= devices; i++) {
      const { data: id } = await b.client.rpc("upsert_push_subscription", { p_endpoint: `https://fcm.googleapis.com/fcm/send/${tag}-${i}-${b.id}`, p_p256dh: "BPdummykeydummykeydummykey", p_auth: "authdummy", p_user_agent: "test" });
      subs.push(id as string);
    }
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: `${tag}-m`, p_body: "hello" });
    await processPendingBatch();
    const { data: q } = await admin().from("push_queue").select("id").eq("account_id", b.id).eq("status", "queued").single();
    return { subs, queueId: q!.id as string };
  }
  const row = async (id: string) => (await admin().from("push_queue").select("status, attempts, deliveries, next_attempt_at").eq("id", id).single()).data!;
  const due = (id: string) => admin().from("push_queue").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", id);

  it("two genuine failures then no time: the run counts as an attempt; the unreached device goes first next time; retries stay bounded", async () => {
    const { subs, queueId } = await queued("pp1", 3);
    const [d1, d2, d3] = subs;
    const sends: string[] = [];
    const fail = (id: string) => Object.assign(new Error(`flaky ${id}`), { statusCode: 500 });
    // each send takes 2.5 s of a 6 s budget: d1 fails, d2 fails, d3 is never reached
    const base = Date.now(); let elapsed = 0;
    const send = async (s: { id: string }) => { sends.push(s.id); elapsed += 2_500; if (s.id !== d3) throw fail(s.id); };
    const r1 = await sendFriendMessagePushes(10, { configured: true, send }, Deadline.in(6_000, () => base + elapsed));
    expect(r1.retried).toBe(1); expect(r1.released).toBe(0);
    let q = await row(queueId);
    expect(q).toMatchObject({ status: "queued", attempts: 1 });                     // genuine failures consumed one attempt
    expect(Object.keys(q.deliveries as object).sort()).toEqual([d1, d2].sort());   // d3 not started: no entry
    // next run: the unreached device goes first and makes progress, the failing ones are retried after it
    sends.length = 0; elapsed = 0; await due(queueId);
    const r2 = await sendFriendMessagePushes(10, { configured: true, send }, Deadline.in(6_000, () => base + elapsed));
    expect(sends[0]).toBe(d3);
    expect(r2.retried).toBe(1);
    q = await row(queueId);
    expect((q.deliveries as Record<string, { status: string }>)[d3].status).toBe("sent");
    expect(q.attempts).toBe(2);
    sends.length = 0; elapsed = 0; await due(queueId);
    const r3 = await sendFriendMessagePushes(10, { configured: true, send }, Deadline.in(60_000, () => base + elapsed));
    expect(r3.failed).toBe(1);
    q = await row(queueId);
    expect(q).toMatchObject({ status: "failed", attempts: 3 });                     // bounded: the cap holds across partial runs
    expect(sends).not.toContain(d3);                                                // delivered once, never resent
    expect((q.deliveries as Record<string, { attempts: number }>)[d1].attempts).toBe(3);
  });

  it("a send that never answers inside the budget is recorded as uncertain (an attempt), and a run that started nothing releases", async () => {
    const { subs, queueId } = await queued("pp2", 2);
    const base = Date.now(); let elapsed = 0;
    const hang = () => new Promise<void>(() => { /* never resolves; the clock races it */ });
    const send = async (_s: unknown, _p: string, timeoutMs: number) => { expect(timeoutMs).toBeLessThanOrEqual(10_000); elapsed += 4_000; return hang(); };
    const r = await sendFriendMessagePushes(10, { configured: true, send }, Deadline.in(3_500, () => base + elapsed));
    expect(r.retried).toBe(1);
    const q = await row(queueId);
    expect(q.attempts).toBe(1);
    const d = (q.deliveries as Record<string, { status: string; attempts: number }>)[subs[0]];
    expect(d).toMatchObject({ status: "uncertain", attempts: 1 });
    await due(queueId);
    let started = 0;
    const r2 = await sendFriendMessagePushes(10, { configured: true, send: async () => { started++; } }, Deadline.in(4_000, () => { const t = base + elapsed; elapsed += 600; return t; }));
    expect(r2.released).toBe(1);
    expect(started).toBe(0);
    expect((await row(queueId)).attempts).toBe(1);                                  // nothing started: nothing consumed
  });
});

describe("4. email outbox: claims sized to the budget, releases, relevance, overlap, failures", () => {
  async function notices(tag: string, pairs: number) {
    await openSessionNow(); await resetQueue();   // once: resetting between pairs would cancel the earlier pairs' invited entries and make their notices obsolete
    const rows: string[] = []; const ids: string[] = [];
    for (let i = 0; i < pairs; i++) {
      const a = await makeUser(`${tag}${i}-a`, LEFT); const b = await makeUser(`${tag}${i}-b`, RIGHT); made.push(a, b);
      await a.client.rpc("join_queue", { p_notify_email: true }); await b.client.rpc("join_queue", { p_notify_email: true });
      expect((await admin().rpc("run_matching")).data).toBe(1);
      const { data } = await admin().from("email_outbox").select("id").in("account_id", [a.id, b.id]).eq("status", "queued");
      for (const r of data ?? []) rows.push(r.id);
      ids.push(a.id, b.id);
    }
    return { rows, ids };
  }
  const states = async (rows: string[]) => (await admin().from("email_outbox").select("id, status, attempts, next_attempt_at, last_error").in("id", rows)).data!;

  it("a short tick claims only what can start; untouched claims are released without an attempt or backoff; the rest is sent later", async () => {
    await admin().from("email_outbox").update({ status: "cancelled", last_error: "test cleanup" }).in("status", ["queued", "claimed"]);
    const { rows } = await notices("eo1", 3);                                       // 6 notices
    expect(rows).toHaveLength(6);
    const base = Date.now(); let elapsed = 0;
    const deliver = async () => { elapsed += 6_000; return "fake"; };               // a slow sender: 6 s per notice
    // 16 s budget: 3 claimed (16/5), two sent (12 s), the third finds < 5 s left and is released as it was
    const r1 = await sendQueuedEmails(20, Deadline.in(16_000, () => base + elapsed), { configured: true, deliver });
    expect(r1).toMatchObject({ sent: 2, released: 1, retried: 0 });
    let s = await states(rows);
    expect(s.filter((x) => x.status === "sent")).toHaveLength(2);
    const untouched = s.filter((x) => x.status === "queued");
    expect(untouched).toHaveLength(4);
    expect(untouched.every((x) => x.attempts === 0)).toBe(true);                    // never claimed, or released: no attempt consumed
    expect(untouched.every((x) => Date.parse(x.next_attempt_at) <= Date.now() + 1000)).toBe(true);   // and no provider-failure backoff
    // a 25 s tick finishes the rest
    elapsed = 0;
    const r2 = await sendQueuedEmails(20, Deadline.in(25_000, () => base + elapsed), { configured: true, deliver });
    expect(r2.sent).toBe(4);
    s = await states(rows);
    expect(s.every((x) => x.status === "sent" && x.attempts === 1)).toBe(true);
  });

  it("expired or declined invitations never send; a genuine failure retries with a consumed attempt; overlapping workers send each notice once", async () => {
    await admin().from("email_outbox").update({ status: "cancelled", last_error: "test cleanup" }).in("status", ["queued", "claimed"]);
    const { rows } = await notices("eo2", 2);                                       // 4 notices, 2 invitations
    const { data: inv } = await admin().from("email_outbox").select("id, payload").in("id", rows);
    const invitations = [...new Set((inv ?? []).map((r) => (r.payload as { invitation_id: string }).invitation_id))];
    // one invitation expires (the tick's expire_stale resolves it → trigger cancels its notices), the other stays pending
    await admin().from("match_invitations").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", invitations[0]);
    await admin().rpc("expire_stale");
    let calls = 0;
    const r = await sendQueuedEmails(20, Deadline.none(), { configured: true, deliver: async () => { calls++; throw new Error("smtp 421 try later"); } });
    expect(calls).toBe(2);                                                          // only the pending invitation's two notices were attempted
    expect(r.retried).toBe(2);
    const s = await states(rows);
    expect(s.filter((x) => x.status === "cancelled")).toHaveLength(2);
    const retried = s.filter((x) => x.status === "queued");
    expect(retried).toHaveLength(2);
    expect(retried.every((x) => x.attempts === 1 && Date.parse(x.next_attempt_at) > Date.now() + 30_000)).toBe(true);   // real failure: attempt + backoff
    await admin().from("email_outbox").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).in("id", retried.map((x) => x.id));
    const sentTo: string[] = [];
    const deliver = async ({ id }: { id: string }) => { sentTo.push(id); await new Promise((res) => setTimeout(res, 150)); return "fake"; };
    const [x, y] = await Promise.all([sendQueuedEmails(20, Deadline.none(), { configured: true, deliver }), sendQueuedEmails(20, Deadline.none(), { configured: true, deliver })]);
    expect(x.sent + y.sent).toBe(2);
    expect(new Set(sentTo).size).toBe(sentTo.length);                              // no notice sent twice
  });
});

describe("5. fair question scheduling in SQL; backoff cannot overflow", () => {
  it("with more than 50 first questions waiting, successors and mid questions are still selected and created", async () => {
    // synthetic live conversations (the scheduler reads only the conversations table)
    const mk = (status: string, asked: number, extra: Record<string, unknown>) => ({ kind: "live", status, questions_asked: asked, opening_question_count: 10, question_gap_seconds: 60, active_seconds_since_question: 0, opened_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), ...extra });
    const batch = [
      ...Array.from({ length: 60 }, (_, i) => mk("opening", 0, { opened_at: new Date(Date.now() - i * 1000).toISOString() })),
      ...Array.from({ length: 4 }, () => mk("opening", 1, {})),
      ...Array.from({ length: 4 }, () => mk("chatting", 1, { active_seconds_since_question: 600, chat_started_at: new Date().toISOString() })),
    ];
    const { data: ins, error } = await admin().from("conversations").insert(batch).select("id, status, questions_asked");
    expect(error).toBeNull();
    const ids = ins!.map((r) => r.id);
    try {
      const { data: work } = await admin().rpc("question_work", { p_limit: 50 });
      const w = (work as { id: string; need: string }[]).filter((x) => ids.includes(x.id));
      expect(w.filter((x) => x.need === "successor")).toHaveLength(4);
      expect(w.filter((x) => x.need === "mid")).toHaveLength(4);
      expect(w.filter((x) => x.need === "first").length).toBeGreaterThanOrEqual(40);
      // oldest first within a kind: the first 'first' item is the oldest opened conversation
      const oldest = ins!.filter((r) => r.status === "opening" && r.questions_asked === 0).map((r) => r.id);
      expect(w.filter((x) => x.need === "first")[0].id).toBe(oldest[59]);
      const t = await runTick({ budgetMs: 48_000, source: "fair-test" });
      const q = t.questions as { asked: number; advanced: number; mid: number };
      expect(q.mid).toBe(4);
      expect(q.advanced).toBeGreaterThanOrEqual(4);
      expect(q.asked).toBeGreaterThanOrEqual(40);
      // large failure counts: the backoff is capped before the exponent can overflow
      await admin().from("conversations").update({ question_failures: 40 }).eq("id", ids[0]);
      expect((await admin().rpc("note_question_failure", { p_conversation: ids[0], p_error: "x" })).error).toBeNull();
      const { data: c } = await admin().from("conversations").select("question_failures, question_retry_at").eq("id", ids[0]).single();
      expect(c!.question_failures).toBe(41);
      expect(Date.parse(c!.question_retry_at)).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 5_000);
    } finally {
      await admin().from("conversations").delete().in("id", ids);
    }
  }, 120_000);
});

describe("6. model-budget exhaustion is its own outcome", () => {
  const calls: ModelRequest[] = [];
  const client = async (req: ModelRequest) => { calls.push(req); return { text: JSON.stringify({ decision: "allow", categories: [], user_explanation: null, suggested_revision: null, confidence: 0.9 }), model: "intercepted" }; };
  afterEach(async () => { setModelClientForTests(null); process.env.AI_PROVIDER = "mock"; delete process.env.ANTHROPIC_API_KEY; await setCfg("model_calls_per_day_per_account", 0); await setCfg("model_calls_per_day_moderation", 0); });

  it("per-account and global exhaustion wait for the reset without attempts or human review; others pass; a provider failure is different", async () => {
    process.env.AI_PROVIDER = "anthropic"; process.env.ANTHROPIC_API_KEY = "test-only"; setModelClientForTests(client);
    await setCfg("model_calls_per_day_per_account", 1);
    const { a, b, conv } = await chatting("bx1");             // the opening round used the bank? no: provider path, so clear usage first
    await admin().from("model_usage").delete().in("account_id", [a.id, b.id]);
    const { data: p1 } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "bx-1", p_body: "one" });
    const { data: p2 } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "bx-2", p_body: "two" });
    const { data: p3 } = await b.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "bx-3", p_body: "from b" });
    const r = await processPendingBatch();
    expect(r).toMatchObject({ processed: 2, budgetDeferred: 1, deferred: 0 });
    expect((await pending(p1!)).status).toBe("approved");
    expect((await pending(p3!)).status).toBe("approved");         // another account stays eligible
    const w = await pending(p2!);
    expect(w).toMatchObject({ status: "pending", attempts: 0 });
    expect(w.user_explanation).toMatch(/daily limit/);
    expect(w.last_error).toMatch(/usage limit/);
    const resetAt = Date.parse((await admin().rpc("model_budget_reset_at")).data as string);
    expect(Date.parse(w.next_attempt_at)).toBeGreaterThanOrEqual(Math.min(resetAt, Date.now() + 59_000));
    // repeated ticks: not re-claimed, no provider call, never escalated to review
    const before = calls.length;
    for (let i = 0; i < 3; i++) expect(await processPendingBatch()).toMatchObject({ processed: 0, budgetDeferred: 0, deferred: 0 });
    expect(calls.length).toBe(before);
    expect((await pending(p2!)).status).toBe("pending");
    // reset: usage cleared and the row due again → delivered
    await admin().from("model_usage").delete().eq("account_id", a.id);
    await admin().from("pending_messages").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", p2!);
    expect((await processPendingBatch()).processed).toBe(1);
    expect((await pending(p2!)).status).toBe("approved");
    // global exhaustion takes the same path
    await setCfg("model_calls_per_day_per_account", 0); await setCfg("model_calls_per_day_moderation", 1);
    await admin().from("model_usage").delete().eq("task", "moderation");
    const { data: p4 } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "bx-4", p_body: "four" });
    const { data: p5 } = await b.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "bx-5", p_body: "five" });
    expect(await processPendingBatch()).toMatchObject({ processed: 1, budgetDeferred: 1 });
    expect([(await pending(p4!)).status, (await pending(p5!)).status].sort()).toEqual(["approved", "pending"]);
    // a genuine provider failure still takes the retry path (attempt consumed, backoff, eventually review)
    await setCfg("model_calls_per_day_moderation", 0);
    setModelClientForTests(async () => { throw new Error("provider down"); });
    const { data: p6 } = await b.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "bx-6", p_body: "six" });
    expect(await processPendingBatch()).toMatchObject({ deferred: 1, budgetDeferred: 0 });
    const f = await pending(p6!);
    expect(f.attempts).toBe(1);
    expect(f.last_error).toMatch(/provider down/);
    expect(f.user_explanation).toBeNull();
  });
});
