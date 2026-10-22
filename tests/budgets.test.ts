// Per-account model budgets through the REAL execution path: the moderation
// worker and question generation call the gateway, which calls the provider
// through an intercepted client (no network) and reserves usage with
// take_model_budget. Account ids travel as server metadata only.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setModelClientForTests, moderate, type ModelRequest } from "@/lib/ai/gateway";
import { processPendingBatch } from "@/lib/workers/moderation";
import { generateNextQuestion } from "@/lib/workers/questions";
import { admin, makeUser, deleteUser, openSessionNow, openConversation, resetQueue, LEFT, RIGHT, type TestUser } from "./helpers";

const calls: ModelRequest[] = [];
const fakeClient = async (req: ModelRequest) => {
  calls.push(req);
  const isQuestion = req.system.includes("facilitate a text conversation");
  const text = isQuestion
    ? JSON.stringify({ shared_question: `What small thing made this week easier? (${calls.length})`, choices: ["A person", "A habit", "Plain luck"], optional_followup_a: null, optional_followup_b: null, rationale_internal: "test", sensitive_topic_flag: false })
    : JSON.stringify({ decision: "allow", categories: [], user_explanation: null, suggested_revision: null, confidence: 0.9 });
  return { text, model: "intercepted-model" };
};
const setCfg = (key: string, value: unknown) => admin().from("policy_config").upsert({ key, value: value as never });
const usage = async (account: string, task: string) => (await admin().from("model_usage").select("calls").eq("account_id", account).eq("task", task).eq("day", new Date().toISOString().slice(0, 10)).maybeSingle()).data?.calls ?? 0;

const made: TestUser[] = [];
beforeAll(() => {
  process.env.AI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-only-not-a-real-key";
  setModelClientForTests(fakeClient);
});
afterAll(async () => {
  setModelClientForTests(null);
  process.env.AI_PROVIDER = "mock";
  delete process.env.ANTHROPIC_API_KEY;
  await setCfg("model_calls_per_day_per_account", 0);
  await setCfg("model_calls_per_day_moderation", 0);
  for (const u of made.splice(0)) await deleteUser(u);
});
afterEach(() => { calls.length = 0; });

describe("per-account model budgets through the gateway and workers", () => {
  it("moderation is attributed to the sender, a shared question to both participants; ids never reach the prompt", async () => {
    await setCfg("model_calls_per_day_per_account", 0);
    await openSessionNow(); await resetQueue();
    const a = await makeUser("bg-a", LEFT); const b = await makeUser("bg-b", RIGHT); made.push(a, b);
    const conv = await openConversation(a, b);
    const qid = await generateNextQuestion(conv, "opening");
    expect(qid).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect((await admin().from("conversation_questions").select("source").eq("id", qid!).single()).data!.source).toBe("ai");
    expect(await usage(a.id, "questions")).toBe(1);
    expect(await usage(b.id, "questions")).toBe(1);
    await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "bg-1", p_body: "my own words", p_kind: "answer", p_question: qid });
    const r = await processPendingBatch();
    expect(r.processed).toBe(1);
    expect(calls).toHaveLength(2);
    expect(await usage(a.id, "moderation")).toBe(1);
    expect(await usage(b.id, "moderation")).toBe(0);
    for (const c of calls) { expect(c.user).not.toContain(a.id); expect(c.user).not.toContain(b.id); expect(c.system).not.toContain(a.id); }
  });

  it("an enabled per-account limit holds the sender's next message without a provider call and without counting it; another sender still passes", async () => {
    await setCfg("model_calls_per_day_per_account", 1);
    await openSessionNow(); await resetQueue();
    const a = await makeUser("bg-c", LEFT); const b = await makeUser("bg-d", RIGHT); made.push(a, b);
    const conv = await openConversation(a, b);
    const qid = await generateNextQuestion(conv, "opening");     // a=1, b=1 for questions (shared)
    expect(calls).toHaveLength(1);
    const { data: p1 } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "bg-2", p_body: "first", p_kind: "answer", p_question: qid });
    const r1 = await processPendingBatch();
    expect(r1.processed).toBe(1);                                 // a's first moderation call fits (limit 1)
    expect(calls).toHaveLength(2);
    expect((await admin().from("pending_messages").select("status").eq("id", p1!).single()).data!.status).toBe("approved");
    // b answers by choice (no moderation) so the next question can be asked: both accounts are at their
    // questions limit → bank fallback, no provider call, no usage
    await b.client.rpc("answer_with_choice", { p_question: qid, p_choice: 1 });
    const qid2 = await generateNextQuestion(conv, "opening");
    expect(qid2).toBeTruthy();
    expect(calls).toHaveLength(2);
    expect((await admin().from("conversation_questions").select("source").eq("id", qid2!).single()).data!.source).toBe("bank");
    expect(await usage(a.id, "questions")).toBe(1);
    expect(await usage(b.id, "questions")).toBe(1);
    // a's second custom answer: over a's moderation limit → held, no provider call, not counted
    const { data: p2, error: e2 } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "bg-3", p_body: "second from the same sender", p_kind: "answer", p_question: qid2 });
    expect(e2).toBeNull();
    const r2 = await processPendingBatch();
    expect(r2.budgetDeferred).toBe(1);                            // its own outcome, not a provider failure
    expect(r2.deferred).toBe(0);
    expect(calls).toHaveLength(2);                                // no provider call for the rejected request
    const held = (await admin().from("pending_messages").select("status, last_error, attempts, user_explanation, next_attempt_at").eq("id", p2!).single()).data!;
    expect(held.status).toBe("pending");
    expect(held.last_error).toMatch(/usage limit/);
    expect(held.attempts).toBe(0);                                // the claim's attempt was given back
    expect(held.user_explanation).toMatch(/daily limit/);
    expect(Date.parse(held.next_attempt_at)).toBeGreaterThan(Date.now() + 50_000);   // waits for the reset, not a quick retry
    expect(await usage(a.id, "moderation")).toBe(1);              // the rejection did not count as usage
    // another sender still passes
    const { data: p3 } = await b.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "bg-4", p_body: "from b", p_kind: "answer", p_question: qid2 });
    const r3 = await processPendingBatch();
    expect(r3.processed).toBe(1);
    expect((await admin().from("pending_messages").select("status").eq("id", p3!).single()).data!.status).toBe("approved");
    expect(calls).toHaveLength(3);
    expect(await usage(b.id, "moderation")).toBe(1);
  });

  it("with a per-account limit enabled, a call without attribution is refused (SQL and gateway) and the global limit still applies", async () => {
    await setCfg("model_calls_per_day_per_account", 1);
    expect((await admin().rpc("take_model_budget", { p_task: "moderation" })).data).toBe(false);
    expect((await admin().rpc("take_model_budget", { p_task: "moderation", p_accounts: [] })).data).toBe(false);
    await expect(moderate({ body: "hello", kind: "chat", recent: [], detectorHits: [] }, {})).rejects.toThrow(/usage limit/);
    expect(calls).toHaveLength(0);
    // global cap: counted once per call, independent of how many accounts are attributed
    await setCfg("model_calls_per_day_per_account", 0);
    await setCfg("model_calls_per_day_moderation", 1);
    await admin().from("model_usage").delete().eq("task", "moderation").eq("account_id", "00000000-0000-0000-0000-000000000000");
    const x = "33333333-3333-4333-8333-333333333333";
    expect((await admin().rpc("take_model_budget", { p_task: "moderation", p_accounts: [x] })).data).toBe(true);
    expect((await admin().rpc("take_model_budget", { p_task: "moderation", p_accounts: [x] })).data).toBe(false);
    expect(await usage(x, "moderation")).toBe(1);                 // the refused reservation left no trace
    await admin().from("model_usage").delete().eq("account_id", x);
    await setCfg("model_calls_per_day_moderation", 0);
  });
});
