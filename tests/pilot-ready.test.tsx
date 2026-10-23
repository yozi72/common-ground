// Pilot-readiness release: held answers can be discarded after an appeal
// (and a later overturn delivers nothing), fair scheduling when only one
// question fits per tick, and stale reminder completions change nothing.
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { setModelClientForTests } from "@/lib/ai/gateway";
import { processPendingBatch } from "@/lib/workers/moderation";
import { generateNextQuestion } from "@/lib/workers/questions";
import { sendDueReminders } from "@/lib/workers/reminders";
import { runTick } from "@/lib/workers/tick";
import { Deadline } from "@/lib/workers/deadline";
import { getScheduleConfig } from "@/lib/schedule-config";
import { nextSessions } from "@/lib/schedule";
import { heldAnswerFor, type HeldMessage } from "@/lib/held-messages";
import { admin, makeUser, deleteUser, openSessionNow, openConversation, finishOpeningRound, resetQueue, LEFT, RIGHT, type TestUser } from "./helpers";

const made: TestUser[] = [];
afterAll(async () => { for (const u of made.splice(0)) await deleteUser(u); });

describe("1. held answers stay recoverable", () => {
  it("discard after an appeal frees the question (answer again or skip), keeps the appeal record, and a later overturn delivers nothing", async () => {
    await openSessionNow(); await resetQueue();
    const a = await makeUser("ha-a", LEFT); const b = await makeUser("ha-b", RIGHT); made.push(a, b);
    const conv = await openConversation(a, b);
    const q1 = (await generateNextQuestion(conv, "opening"))!;
    const { data: pid } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "ha-1", p_body: "my number is 415 555 0199", p_kind: "answer", p_question: q1 });
    await processPendingBatch();
    let held = ((await a.client.rpc("my_held_messages", { p_conversation: conv })).data ?? []) as HeldMessage[];
    expect(held[0]).toMatchObject({ id: pid, kind: "answer", question_id: q1, status: "revise" });   // tied to its question
    expect(heldAnswerFor(held, q1)?.id).toBe(pid);
    const { data: appeal } = await a.client.rpc("file_appeal", { p_pending: pid, p_note: "it is my own number" });
    expect((await a.client.rpc("cancel_pending", { p_pending: pid })).error).toBeNull();           // Discard while the appeal is open
    held = ((await a.client.rpc("my_held_messages", { p_conversation: conv })).data ?? []) as HeldMessage[];
    expect(held[0]).toMatchObject({ id: pid, status: "cancelled", appeal_status: "open" });        // record kept, no longer a held answer
    expect(heldAnswerFor(held, q1)).toBeNull();
    expect((await admin().from("question_answers").select("question_id").eq("question_id", q1).eq("status", "pending")).data).toEqual([]);
    expect((await a.client.rpc("answer_with_choice", { p_question: q1, p_choice: 1 })).error).toBeNull();   // the question is usable again
    const { data: r } = await admin().rpc("resolve_appeal", { p_appeal: appeal, p_status: "overturned", p_note: null, p_resolver: null });
    expect(r).toMatchObject({ delivered: false });
    expect((await admin().from("approved_messages").select("id").eq("conversation_id", conv)).data).toEqual([]);   // the discarded answer is never delivered
    expect((await admin().from("question_answers").select("status, choice_index").eq("question_id", q1).single()).data).toMatchObject({ status: "approved", choice_index: 1 });
    // an upheld appeal does not block a discard either
    const q2id = (await admin().from("conversation_questions").select("id").eq("conversation_id", conv).eq("status", "open").maybeSingle()).data?.id
      ?? (await b.client.rpc("answer_with_choice", { p_question: q1, p_choice: 0 }).then(() => generateNextQuestion(conv, "opening")));
    const { data: pid2 } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "ha-2", p_body: "call me 415 555 0100", p_kind: "answer", p_question: q2id });
    await processPendingBatch();
    const { data: ap2 } = await a.client.rpc("file_appeal", { p_pending: pid2, p_note: "" });
    await admin().rpc("resolve_appeal", { p_appeal: ap2, p_status: "upheld", p_note: "stands", p_resolver: null });
    expect((await a.client.rpc("cancel_pending", { p_pending: pid2 })).error).toBeNull();
    expect((await a.client.rpc("skip_question", { p_question: q2id })).error).toBeNull();           // or skip
  });
});

describe("2. fair scheduling when only one generation fits per tick", () => {
  const mk = (status: string, asked: number, extra: Record<string, unknown>) => ({ kind: "live", status, questions_asked: asked, opening_question_count: 10, question_gap_seconds: 60, active_seconds_since_question: 0, opened_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), ...extra });
  afterEach(() => { setModelClientForTests(null); process.env.AI_PROVIDER = "mock"; delete process.env.ANTHROPIC_API_KEY; });
  it("with a moderation backlog, 5 s generations, a 25 s budget and new first questions every tick, the waiting successor and mid questions are generated within four ticks", async () => {
    process.env.AI_PROVIDER = "anthropic"; process.env.ANTHROPIC_API_KEY = "test-only";
    let n = 0;
    setModelClientForTests(async (req) => { n++; const q = req.system.includes("facilitate"); await new Promise((r) => setTimeout(r, q ? 5_000 : 1_000)); return { text: JSON.stringify(q ? { shared_question: `What helped lately? (${n})`, choices: ["A", "B", "C"], optional_followup_a: null, optional_followup_b: null, rationale_internal: "t", sensitive_topic_flag: false } : { decision: "allow", categories: [], user_explanation: null, suggested_revision: null, confidence: 0.9 }), model: "x" }; });
    await openSessionNow(); await resetQueue();
    const a = await makeUser("fs-a", LEFT); const b = await makeUser("fs-b", RIGHT); made.push(a, b);
    const chat = await openConversation(a, b);
    process.env.AI_PROVIDER = "mock";                                   // the opening round with the bank, instantly
    expect(await finishOpeningRound(a, b, chat, generateNextQuestion)).toBe("chatting");
    process.env.AI_PROVIDER = "anthropic";
    const ids: string[] = [];
    const insert = async (rows: Record<string, unknown>[]) => { const { data } = await admin().from("conversations").insert(rows).select("id"); for (const r of data!) ids.push(r.id); return data!.map((r) => r.id as string); };
    try {
      const [succ] = await insert([mk("opening", 1, { opened_at: new Date(Date.now() - 20 * 60_000).toISOString() })]);
      await admin().from("conversation_questions").insert({ conversation_id: succ, seq: 1, phase: "opening", question_text: "q1", choices: ["a", "b", "c"], status: "revealed", revealed_at: new Date(Date.now() - 10 * 60_000).toISOString(), created_at: new Date(Date.now() - 11 * 60_000).toISOString(), source: "bank" });
      const [mid] = await insert([mk("chatting", 3, { active_seconds_since_question: 900, chat_started_at: new Date().toISOString(), opened_at: new Date(Date.now() - 30 * 60_000).toISOString() })]);
      await admin().from("conversation_questions").insert({ conversation_id: mid, seq: 3, phase: "mid", question_text: "q3", choices: ["a", "b", "c"], status: "revealed", revealed_at: new Date(Date.now() - 12 * 60_000).toISOString(), created_at: new Date(Date.now() - 13 * 60_000).toISOString(), source: "bank" });
      let succDone = false, midDone = false, runs = 0;
      for (let t = 0; t < 4 && !(succDone && midDone); t++) {
        for (let i = 0; i < 3; i++) await a.client.rpc("submit_message", { p_conversation: chat, p_client_send_id: `fs-${t}-${i}`, p_body: `backlog ${t} ${i}` });   // moderation backlog each tick
        await insert(Array.from({ length: 6 }, () => mk("opening", 0, {})));                                     // new first questions keep arriving
        const out = await runTick({ budgetMs: 25_000, source: "one-fit" });
        runs++;
        const q = out.questions as { asked: number; advanced: number; mid: number };
        expect(q.asked + q.advanced + q.mid).toBeGreaterThanOrEqual(1);
        succDone = (await admin().from("conversation_questions").select("id").eq("conversation_id", succ)).data!.length >= 2;
        midDone = (await admin().from("conversation_questions").select("id").eq("conversation_id", mid)).data!.length >= 2;
      }
      expect(succDone, "successor generated").toBe(true);
      expect(midDone, "mid question generated").toBe(true);
      expect(runs).toBeLessThanOrEqual(4);
      expect((await admin().from("pending_messages").select("id").eq("conversation_id", chat).eq("status", "approved")).data!.length).toBeGreaterThanOrEqual(3);   // moderation progressed too
    } finally {
      await admin().from("conversations").delete().in("id", ids);
    }
  }, 240_000);
});

describe("4. reminder completion is claim-conditional", () => {
  it("a stale worker's 'sent' does not overwrite a job another worker reclaimed", async () => {
    await admin().from("reminder_prefs").update({ push_enabled: false, email_enabled: false }).or("push_enabled.eq.true,email_enabled.eq.true");
    await openSessionNow();
    const u = await makeUser("sc-a", LEFT); made.push(u);
    await u.client.from("reminder_prefs").upsert({ account_id: u.id, push_enabled: true, email_enabled: false, mode: "daily", days: [0, 1, 2, 3, 4, 5, 6], minutes_before: 10 });
    await u.client.rpc("upsert_push_subscription", { p_endpoint: `https://fcm.googleapis.com/fcm/send/sc-${u.id}`, p_p256dh: "BPdummykeydummykeydummykey", p_auth: "authdummy", p_user_agent: "test" });
    const cfg = await getScheduleConfig();
    const at = nextSessions(Date.now() + 3 * 3600_000, 1, cfg)[0].start - 9 * 60_000;
    // while the (slow) send is in flight, another worker treats the claim as abandoned and re-claims it (attempts 2)
    const r = await sendDueReminders(at, Deadline.none(), { pushConfigured: true, emailConfigured: false, sendPush: async () => {
      await admin().from("reminder_sends").update({ attempts: 2, claimed_at: new Date().toISOString() }).eq("account_id", u.id).eq("channel", "push");
    } });
    expect(r.push.sent).toBe(1);                                                    // the stale worker believes it sent...
    const { data: row } = await admin().from("reminder_sends").select("status, attempts, sent_at").eq("account_id", u.id).eq("channel", "push").single();
    expect(row).toMatchObject({ status: "claimed", attempts: 2, sent_at: null });   // ...but the newer claim's state is untouched
    // the normal path still completes
    await admin().from("reminder_sends").update({ attempts: 1 }).eq("account_id", u.id).eq("channel", "push");
    await admin().from("reminder_sends").update({ claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq("account_id", u.id);   // abandoned → re-claimable
    const r2 = await sendDueReminders(at, Deadline.none(), { pushConfigured: true, emailConfigured: false, sendPush: async () => undefined });
    expect(r2.push.sent).toBe(1);
    expect((await admin().from("reminder_sends").select("status, attempts").eq("account_id", u.id).eq("channel", "push").single()).data).toMatchObject({ status: "sent", attempts: 2 });
  });
});
