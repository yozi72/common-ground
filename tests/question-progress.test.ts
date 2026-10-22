// Question generation under backlog: across several ticks with a slow
// intercepted provider, both moderation and question generation make real
// progress (questions are created, rounds advance, mid questions appear), and
// a conversation whose insert keeps failing backs off instead of monopolizing
// the stage.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setModelClientForTests, type ModelRequest } from "@/lib/ai/gateway";
import { runTick, interleaveWork, QUESTION_ITEM_MS } from "@/lib/workers/tick";
import { generateNextQuestion } from "@/lib/workers/questions";
import { admin, makeUser, deleteUser, openSessionNow, openConversation, finishOpeningRound, resetQueue, LEFT, RIGHT, type TestUser } from "./helpers";
import { withPg } from "./pg";

const PROVIDER_MS = 1_200;
let calls = 0;
const slowClient = async (req: ModelRequest) => {
  calls++;
  await new Promise((r) => setTimeout(r, PROVIDER_MS));
  const isQuestion = req.system.includes("facilitate a text conversation");
  return { text: isQuestion
    ? JSON.stringify({ shared_question: `What helped you get through a hard week? (${calls})`, choices: ["A person", "A routine", "Time alone"], optional_followup_a: null, optional_followup_b: null, rationale_internal: "t", sensitive_topic_flag: false })
    : JSON.stringify({ decision: "allow", categories: [], user_explanation: null, suggested_revision: null, confidence: 0.9 }), model: "intercepted" };
};
const made: TestUser[] = [];
const POISON_FN = "cg_test_poison_question";
beforeAll(() => { process.env.AI_PROVIDER = "anthropic"; process.env.ANTHROPIC_API_KEY = "test-only-not-a-real-key"; setModelClientForTests(slowClient); });
afterAll(async () => {
  setModelClientForTests(null); process.env.AI_PROVIDER = "mock"; delete process.env.ANTHROPIC_API_KEY;
  await withPg((c) => c.query(`drop trigger if exists ${POISON_FN} on public.conversation_questions; drop function if exists public.${POISON_FN}()`));
  for (const u of made.splice(0)) await deleteUser(u);
});
const asked = async (id: string) => (await admin().from("conversations").select("questions_asked, status, question_failures, question_retry_at").eq("id", id).single()).data!;

describe("question generation keeps up under backlog", () => {
  it("interleaves the three kinds of work", () => {
    const w = (need: "first" | "successor" | "mid", n: number) => Array.from({ length: n }, (_, i) => ({ id: `${need}${i}`, need }));
    expect(interleaveWork([...w("first", 3), ...w("mid", 1), ...w("successor", 2)]).map((x) => x.id)).toEqual(["first0", "successor0", "mid0", "first1", "successor1", "first2"]);
  });

  it("every tick creates questions AND moderates messages; failing conversations back off; successors and mid questions progress", async () => {
    await openSessionNow(); await resetQueue();
    // backlog: 5 opening conversations with no question yet
    const fresh: string[] = [];
    for (let i = 0; i < 5; i++) {
      const a = await makeUser(`qp${i}-a`, LEFT); const b = await makeUser(`qp${i}-b`, RIGHT); made.push(a, b);
      fresh.push(await openConversation(a, b));
    }
    // a chatting pair with 4 pending messages (moderation backlog)
    const ca = await makeUser("qp-chat-a", LEFT); const cb = await makeUser("qp-chat-b", RIGHT); made.push(ca, cb);
    const chat = await openConversation(ca, cb);
    expect(await finishOpeningRound(ca, cb, chat, generateNextQuestion)).toBe("chatting");
    for (let i = 0; i < 4; i++) await ca.client.rpc("submit_message", { p_conversation: chat, p_client_send_id: `qp-m${i}`, p_body: `message ${i}` });
    // a poisoned conversation whose question insert always fails (temporary trigger, dropped in afterAll)
    const pa = await makeUser("qp-poison-a", LEFT); const pb = await makeUser("qp-poison-b", RIGHT); made.push(pa, pb);
    const poison = await openConversation(pa, pb);
    await withPg((c) => c.query(`
      create or replace function public.${POISON_FN}() returns trigger language plpgsql as $$
      begin if new.conversation_id = '${poison}' then raise exception 'poisoned conversation (test)'; end if; return new; end $$;
      create trigger ${POISON_FN} before insert on public.conversation_questions for each row execute function public.${POISON_FN}();`));
    // make the poisoned one first in line so it would monopolize the stage if it could
    await admin().from("conversations").update({ opened_at: new Date(Date.now() - 3600_000).toISOString() }).eq("id", poison);

    const callsBefore = calls;
    const t1 = await runTick({ budgetMs: 25_000, source: "qp-test" });
    const m1 = t1.moderation as { processed: number }; const q1 = t1.questions as { asked: number; failed: number; deferred: number };
    expect(m1.processed).toBe(4);                                  // moderation drained its backlog
    expect(q1.asked).toBeGreaterThanOrEqual(2);                     // and questions were still created in the same tick
    expect(q1.failed).toBe(1);                                      // the poisoned one failed once...
    const p1 = await asked(poison);
    expect(p1.question_failures).toBe(1);
    expect(Date.parse(p1.question_retry_at!)).toBeGreaterThan(Date.now());   // ...and is backed off
    expect(calls - callsBefore).toBeGreaterThanOrEqual(4 + q1.asked);

    const t2 = await runTick({ budgetMs: 25_000, source: "qp-test" });
    const q2 = t2.questions as { asked: number; failed: number };
    expect(q2.failed).toBe(0);                                      // backed off: not retried, no time spent on it
    for (const id of fresh) expect((await asked(id)).questions_asked, id).toBe(1);   // every fresh conversation has its first question

    // successors: both answer the first question in one conversation → revealed → the next one is due
    const [a0, b0] = made.slice(0, 2);
    const { data: q } = await admin().from("conversation_questions").select("id").eq("conversation_id", fresh[0]).eq("status", "open").single();
    await a0.client.rpc("answer_with_choice", { p_question: q!.id, p_choice: 0 });
    await b0.client.rpc("answer_with_choice", { p_question: q!.id, p_choice: 1 });
    expect((await admin().from("conversation_questions").select("status").eq("id", q!.id).single()).data!.status).toBe("revealed");
    // mid: the chatting pair is due for its next shared question
    await admin().from("conversations").update({ active_seconds_since_question: 10_000 }).eq("id", chat);
    const t3 = await runTick({ budgetMs: 25_000, source: "qp-test" });
    const q3 = t3.questions as { advanced: number; mid: number };
    expect(q3.advanced).toBeGreaterThanOrEqual(1);
    expect(q3.mid).toBeGreaterThanOrEqual(1);
    expect((await asked(fresh[0])).questions_asked).toBe(2);
    expect((await admin().from("conversation_questions").select("id").eq("conversation_id", chat).eq("phase", "mid")).data!.length).toBeGreaterThanOrEqual(1);

    // a tick too short for both still moderates (and reports the question stage as deferred, not silently fine)
    await ca.client.rpc("submit_message", { p_conversation: chat, p_client_send_id: "qp-late", p_body: "one more" });
    const t4 = await runTick({ budgetMs: QUESTION_ITEM_MS + 7_000, source: "qp-test" });
    expect((t4.moderation as { processed: number }).processed).toBe(1);
  }, 120_000);
});
