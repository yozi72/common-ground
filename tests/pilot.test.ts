import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { admin, makeUser, deleteUser, resetQueue, openSessionNow, closeSessions, LEFT, RIGHT, MIXED, FEW, KEYS, matchPair, openConversation, finishOpeningRound, type TestUser } from "./helpers";
import { buildQuestionInput } from "@/lib/workers/questions";
import { sendDueReminders } from "@/lib/workers/reminders";
import { sessionDueForReminder, DEFAULT_SCHEDULE } from "@/lib/schedule";
import { getScheduleConfig } from "@/lib/schedule-config";
import { processPendingBatch } from "@/lib/workers/moderation";
import { generateNextQuestion } from "@/lib/workers/questions";

const users: TestUser[] = [];
async function user(tag: string, answers: Record<string, number>, onboard = true, extra: { nonanswers?: Record<string, "unsure" | "declined">; priorities?: string[] } = {}) {
  const u = await makeUser(tag, answers, onboard, extra);
  users.push(u);
  return u;
}

beforeAll(async () => {
  process.env.AI_PROVIDER = "mock";
  await openSessionNow();
});
beforeEach(async () => {
  await openSessionNow();
  await resetQueue();
});
afterAll(async () => {
  for (const u of users) await deleteUser(u).catch(() => {});
});

describe("identity isolation and unauthorized reads", () => {
  it("a user cannot read another user's profile, account, or questionnaire", async () => {
    const a = await user("iso-a", LEFT);
    const b = await user("iso-b", RIGHT);
    const { data: profiles } = await b.client.from("profiles").select("account_id, political_answers");
    expect(profiles?.map((p) => p.account_id)).toEqual([b.id]);
    const { data: accounts } = await b.client.from("accounts").select("id");
    expect(accounts?.map((p) => p.id)).toEqual([b.id]);
    const { data: aProfile } = await b.client.from("profiles").select("*").eq("account_id", a.id);
    expect(aProfile).toEqual([]);
  });

  it("a third party cannot read a conversation, its aliases, questions, or messages", async () => {
    const a = await user("conv-a", LEFT);
    const b = await user("conv-b", RIGHT);
    const c = await user("conv-c", MIXED);
    const conv = await openConversation(a, b);
    const [convs, aliases, parts, qs, msgs] = await Promise.all([
      c.client.from("conversations").select("id").eq("id", conv),
      c.client.from("participant_aliases").select("*").eq("conversation_id", conv),
      c.client.from("participants").select("*").eq("conversation_id", conv),
      c.client.from("conversation_questions").select("id, question_text").eq("conversation_id", conv),
      c.client.from("approved_messages").select("*").eq("conversation_id", conv),
    ]);
    expect(convs.data).toEqual([]);
    expect(aliases.data).toEqual([]);
    expect(parts.data).toEqual([]);
    expect(qs.data).toEqual([]);
    expect(msgs.data).toEqual([]);
    const { error } = await c.client.rpc("heartbeat", { p_conversation: conv });
    expect(error).toBeNull(); // no-op; nothing to update
    const { error: e2 } = await c.client.rpc("leave_conversation", { p_conversation: conv });
    expect(e2?.code).toBe("42501");
  });

  it("participants see each other's alias but never the account id; invitations carry no account ids", async () => {
    const a = await user("alias-a", LEFT);
    const b = await user("alias-b", RIGHT);
    const conv = await openConversation(a, b);
    const { data: parts } = await a.client.from("participants").select("account_id").eq("conversation_id", conv);
    expect(parts?.map((p) => p.account_id)).toEqual([a.id]); // own row only
    const { data: aliases } = await a.client.from("participant_aliases").select("alias").eq("conversation_id", conv);
    expect(aliases?.length).toBe(2);
    const { data: ips } = await a.client.from("invitation_participants").select("account_id");
    expect(new Set(ips?.map((i) => i.account_id))).toEqual(new Set([a.id]));
    const { data: inv } = await a.client.from("match_invitations").select("*");
    expect(inv?.length).toBe(1);
    expect(Object.keys(inv![0])).not.toContain("account_id");
    // rationale_internal is not selectable by participants
    const { error } = await a.client.from("conversation_questions").select("rationale_internal").eq("conversation_id", conv);
    expect(error).not.toBeNull();
  });

  it("the lobby's live-conversation lookup resolves (embed disambiguation)", async () => {
    const a = await user("live-a", LEFT);
    const b = await user("live-b", RIGHT);
    const conv = await openConversation(a, b);
    const { data, error } = await a.client.from("participants")
      .select("conversation_id, conversations!participants_conversation_id_fkey!inner(status)")
      .eq("account_id", a.id).is("left_at", null).neq("conversations.status", "ended").limit(1);
    expect(error).toBeNull();
    expect(data?.[0]?.conversation_id).toBe(conv);
  });

  it("clients cannot write approved_messages or pending_messages directly", async () => {
    const a = await user("write-a", LEFT);
    const b = await user("write-b", RIGHT);
    const conv = await openConversation(a, b);
    const { data: me } = await a.client.from("participants").select("id").eq("conversation_id", conv).single();
    const r1 = await a.client.from("approved_messages").insert({ conversation_id: conv, sender_participant_id: me!.id, body: "sneaky" });
    expect(r1.error).not.toBeNull();
    const r2 = await a.client.from("pending_messages").insert({ conversation_id: conv, sender_participant_id: me!.id, client_send_id: "x", body: "sneaky" });
    expect(r2.error).not.toBeNull();
    const r3 = await a.client.rpc("apply_moderation_decision", { p_pending: me!.id, p_decision: "allow", p_categories: [], p_user_explanation: null, p_suggested_revision: null, p_confidence: 1, p_detector_hits: [], p_provider: "x", p_model: null, p_raw_valid: true, p_latency_ms: 0 });
    expect(r3.error).not.toBeNull();
    const r4 = await a.client.rpc("run_matching");
    expect(r4.error).not.toBeNull();
  });
});

describe("matching", () => {
  it("pairs two different users, not two similar ones, and respects blocks", async () => {
    const a = await user("m-a", LEFT);
    const a2 = await user("m-a2", LEFT);
    await a.client.rpc("join_queue", { p_notify_email: false });
    await a2.client.rpc("join_queue", { p_notify_email: false });
    const { data: p0 } = await admin().rpc("run_matching");
    expect(p0).toBe(0); // too similar
    const b = await user("m-b", RIGHT);
    await b.client.rpc("join_queue", { p_notify_email: false });
    const { data: p1 } = await admin().rpc("run_matching");
    expect(p1).toBe(1);
    const { data: reqs } = await admin().from("availability_requests").select("account_id, status").in("account_id", [a.id, a2.id, b.id]);
    const byId = Object.fromEntries(reqs!.map((r) => [r.account_id, r.status]));
    expect(byId[a.id]).toBe("invited"); // oldest waiter first
    expect(byId[b.id]).toBe("invited");
    expect(byId[a2.id]).toBe("waiting");
  });

  it("v2 scoring in the database: five shared answers required; not-sure/declined/untouched never count; versions must match", async () => {
    // insufficient overlap (4 shared) → not matched even though every shared answer is opposite
    const few = await user("v2-few", FEW);
    const l = await user("v2-l", LEFT);
    await few.client.rpc("join_queue", { p_notify_email: false });
    await l.client.rpc("join_queue", { p_notify_email: false });
    expect((await admin().rpc("run_matching")).data).toBe(0);
    const { data: ds } = await admin().rpc("difference_score", { a: FEW, b: LEFT });
    expect(ds).toBeNull();
    // non-answers are stored separately and are not answers
    const ns = await user("v2-ns", { public_services: 0 }, true, { nonanswers: { healthcare: "unsure", abortion: "declined" }, priorities: ["healthcare", "climate"] });
    const { data: prof } = await admin().from("profiles").select("political_answers, political_nonanswers, issue_priorities, questionnaire_version").eq("account_id", ns.id).single();
    expect(prof).toEqual({ political_answers: { public_services: 0 }, political_nonanswers: { healthcare: "unsure", abortion: "declined" }, issue_priorities: ["healthcare", "climate"], questionnaire_version: 2 });
    const { data: d2 } = await admin().rpc("shared_answers", { a: prof!.political_answers, b: LEFT });
    expect(d2).toBe(1);
    // explicit middle counts as substantive
    const mid = await user("v2-mid", MIXED);
    const { data: d3 } = await admin().rpc("difference_score", { a: MIXED, b: LEFT });
    expect(Number(d3)).toBeCloseTo((0.5 + 0.75 + 0.25 + 0.5 + 0.5) / 5, 3);
    // version mismatch is never compared
    await admin().from("profiles").update({ questionnaire_version: 1 }).eq("account_id", mid.id);
    await resetQueue();
    await mid.client.rpc("join_queue", { p_notify_email: false });
    await l.client.rpc("join_queue", { p_notify_email: false });
    expect((await admin().rpc("run_matching")).data).toBe(0);
    await admin().from("profiles").update({ questionnaire_version: 2 }).eq("account_id", mid.id);
    expect((await admin().rpc("run_matching")).data).toBe(1); // 0.5 ≥ 0.4
    // server validation
    const bad = await ns.client.rpc("complete_onboarding", { p_age_band: null, p_region: null, p_community: null, p_life_context: [], p_share_context: false, p_political_answers: { abortion: 1.5 }, p_political_nonanswers: {}, p_issue_priorities: [], p_questionnaire_version: 2, p_terms_version: "t" });
    expect(bad.error?.message).toMatch(/out of range/);
    const bad2 = await ns.client.rpc("complete_onboarding", { p_age_band: null, p_region: null, p_community: null, p_life_context: [], p_share_context: false, p_political_answers: {}, p_political_nonanswers: {}, p_issue_priorities: ["a", "b", "c"], p_questionnaire_version: 2, p_terms_version: "t" });
    expect(bad2.error?.message).toMatch(/two priorities/);
  });

  it("people with insufficient answers can choose 'anyone available' immediately; both must allow it", async () => {
    const few = await user("ia-few", FEW);
    const l = await user("ia-l", LEFT);
    await few.client.rpc("join_queue", { p_notify_email: false });
    await l.client.rpc("join_queue", { p_notify_email: false });
    expect((await few.client.rpc("set_broaden", { p_level: "any" })).error).toBeNull(); // no 120 s wait
    expect((await l.client.rpc("set_broaden", { p_level: "any" })).error?.message).toMatch(/not yet/); // l has enough answers
    expect((await admin().rpc("run_matching")).data).toBe(0); // l hasn't consented
    await admin().from("availability_requests").update({ created_at: new Date(Date.now() - 130_000).toISOString() }).eq("account_id", l.id);
    expect((await l.client.rpc("set_broaden", { p_level: "any" })).error).toBeNull();
    expect((await admin().rpc("run_matching")).data).toBe(1);
  });

  it("existing accounts keep their data when they complete the new questionnaire", async () => {
    const a = await user("ex-a", LEFT, true, { priorities: ["climate"] });
    const { data: before } = await admin().from("accounts").select("id, role, created_at").eq("id", a.id).single();
    const { data: consents } = await admin().from("consent_events").select("id").eq("account_id", a.id);
    const r = await a.client.rpc("complete_onboarding", { p_age_band: "35-44", p_region: "south", p_community: "rural", p_life_context: ["veteran"], p_share_context: true, p_political_answers: RIGHT, p_political_nonanswers: {}, p_issue_priorities: ["abortion", "gun_purchases"], p_questionnaire_version: 2, p_terms_version: "pilot-v1" });
    expect(r.error).toBeNull();
    const { data: after } = await admin().from("accounts").select("id, role, created_at, onboarding_complete").eq("id", a.id).single();
    expect(after).toMatchObject(before!);
    const { data: consents2 } = await admin().from("consent_events").select("id").eq("account_id", a.id);
    expect(consents2!.length).toBe(consents!.length + 2);
    const { data: prof } = await admin().from("profiles").select("political_answers, issue_priorities, life_context").eq("account_id", a.id).single();
    expect(prof).toEqual({ political_answers: RIGHT, issue_priorities: ["abortion", "gun_purchases"], life_context: ["veteran"] });
  });

  it("political answers and priorities never reach the question model", async () => {
    const input = buildQuestionInput({ phase: "opening", seq: 1, profiles: [{ life_context: ["parent"], share_context_with_prompts: true }, { life_context: ["veteran"], share_context_with_prompts: true }], previous: ["q1"], skipped: [], recent: [{ alias: "A", body: "hi" }] });
    const text = JSON.stringify(input);
    for (const k of [...KEYS, "political", "priorit", "questionnaire", "age_band", "region", "email"]) expect(text).not.toContain(k);
    expect(input.sharedContext).toEqual([{ lifeContext: ["parent"] }, { lifeContext: ["veteran"] }]);
    const noConsent = buildQuestionInput({ phase: "mid", seq: 11, profiles: [{ life_context: ["parent"], share_context_with_prompts: true }, { life_context: ["veteran"], share_context_with_prompts: false }], previous: [], skipped: [], recent: [] });
    expect(noConsent.sharedContext).toBeNull();
  });

  it("concurrent acceptances open exactly one conversation; a decline requeues the other", async () => {
    const a = await user("acc-a", LEFT);
    const b = await user("acc-b", RIGHT);
    const { invitationId } = await matchPair(a, b);
    const results = await Promise.all([
      a.client.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true }),
      b.client.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true }),
      a.client.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true }), // duplicate click
    ]);
    const opened = results.filter((r) => r.data?.status === "opened");
    expect(opened.length).toBeGreaterThanOrEqual(1);
    const convIds = new Set(opened.map((r) => r.data.conversation_id));
    expect(convIds.size).toBe(1);
    const { data: convs } = await admin().from("conversations").select("id").eq("invitation_id", invitationId);
    expect(convs!.length).toBe(1);
    const { data: parts } = await admin().from("participants").select("id").eq("conversation_id", convs![0].id);
    expect(parts!.length).toBe(2);

    // decline path
    const c = await user("acc-c", LEFT);
    const d = await user("acc-d", RIGHT);
    const { invitationId: inv2 } = await matchPair(c, d);
    const { data: dec } = await c.client.rpc("respond_invitation", { p_invitation: inv2, p_accept: false });
    expect(dec.status).toBe("declined");
    const { data: reqs } = await admin().from("availability_requests").select("account_id, status").in("account_id", [c.id, d.id]);
    const byId = Object.fromEntries(reqs!.map((r) => [r.account_id, r.status]));
    expect(byId[c.id]).toBe("cancelled");
    expect(byId[d.id]).toBe("waiting");
    const { data: late } = await d.client.rpc("respond_invitation", { p_invitation: inv2, p_accept: true });
    expect(late.status).toBe("declined");
  });

  it("expired invitations requeue both and cannot be accepted", async () => {
    const a = await user("exp-a", LEFT);
    const b = await user("exp-b", RIGHT);
    const { invitationId } = await matchPair(a, b);
    await admin().from("match_invitations").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", invitationId);
    const { data } = await a.client.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true });
    expect(data.status).toBe("expired");
    const { data: reqs } = await admin().from("availability_requests").select("status").in("account_id", [a.id, b.id]);
    expect(reqs!.map((r) => r.status)).toEqual(["waiting", "waiting"]);
  });
});

describe("questions and reveal", () => {
  it("hides the peer's answer until both answered, then reveals; skipping counts", async () => {
    const a = await user("q-a", LEFT);
    const b = await user("q-b", RIGHT);
    const conv = await openConversation(a, b);
    const qid = await generateNextQuestion(conv, "opening");
    expect(qid).toBeTruthy();
    const { data: r1 } = await a.client.rpc("answer_with_choice", { p_question: qid, p_choice: 1 });
    expect(r1.revealed).toBe(false);
    const { data: bView } = await b.client.from("question_answers").select("*").eq("question_id", qid);
    expect(bView).toEqual([]); // b cannot see a's answer yet
    const { data: r2 } = await b.client.rpc("skip_question", { p_question: qid });
    expect(r2.revealed).toBe(true);
    const { data: bView2 } = await b.client.from("question_answers").select("participant_id, choice_index, status").eq("question_id", qid);
    expect(bView2!.length).toBe(2);
    const { data: conv2 } = await a.client.from("conversations").select("status, questions_asked").eq("id", conv).single();
    expect(conv2!.status).toBe("opening");
    expect(conv2!.questions_asked).toBe(1);
  });

  it("moves to chatting after the opening round; chat is refused before that", async () => {
    const a = await user("ch-a", LEFT);
    const b = await user("ch-b", RIGHT);
    const conv = await openConversation(a, b);
    const { error } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "early-1", p_body: "hi" });
    expect(error?.code).toBe("P0001");
    const status = await finishOpeningRound(a, b, conv, generateNextQuestion);
    expect(status).toBe("chatting");
  });

  it("custom answers are moderated like messages and revealed only once approved", async () => {
    const a = await user("ca-a", LEFT);
    const b = await user("ca-b", RIGHT);
    const conv = await openConversation(a, b);
    const qid = await generateNextQuestion(conv, "opening");
    const { data: pendingId, error } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "ans-1", p_body: "My own words here", p_kind: "answer", p_question: qid });
    expect(error).toBeNull();
    await b.client.rpc("answer_with_choice", { p_question: qid, p_choice: 0 });
    let { data: q } = await admin().from("conversation_questions").select("status").eq("id", qid).single();
    expect(q!.status).toBe("open"); // a's answer still pending
    await processPendingBatch();
    ({ data: q } = await admin().from("conversation_questions").select("status").eq("id", qid).single());
    expect(q!.status).toBe("revealed");
    const { data: ans } = await b.client.from("question_answers").select("custom_text, status").eq("question_id", qid).neq("status", "approved");
    expect(ans).toEqual([]);
    const { data: p } = await a.client.from("pending_messages").select("status").eq("id", pendingId).single();
    expect(p!.status).toBe("approved");
  });
});

describe("sending and moderation", () => {
  async function chatting() {
    const a = await user("s-a", LEFT);
    const b = await user("s-b", RIGHT);
    const conv = await openConversation(a, b);
    await finishOpeningRound(a, b, conv, generateNextQuestion);
    return { a, b, conv };
  }

  it("delivers a clean message only after the worker approves; recipient never sees pending", async () => {
    const { a, b, conv } = await chatting();
    const { data: pid } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "m-1", p_body: "Honestly that's been hard for me too." });
    const { data: before } = await b.client.from("approved_messages").select("*").eq("conversation_id", conv);
    expect(before).toEqual([]);
    const { data: bPending } = await b.client.from("pending_messages").select("*").eq("conversation_id", conv);
    expect(bPending).toEqual([]);
    const r = await processPendingBatch();
    expect(r.processed).toBeGreaterThanOrEqual(1);
    const { data: after } = await b.client.from("approved_messages").select("body, pending_message_id").eq("conversation_id", conv);
    expect(after!.map((m) => m.body)).toEqual(["Honestly that's been hard for me too."]);
    expect(after![0].pending_message_id).toBe(pid);
    const { data: dec } = await admin().from("moderation_decisions").select("decision, provider").eq("pending_message_id", pid).single();
    expect(dec).toEqual({ decision: "allow", provider: "mock" });
  });

  it("is idempotent on client_send_id", async () => {
    const { a, conv } = await chatting();
    const [r1, r2] = await Promise.all([
      a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "dup-1", p_body: "once" }),
      a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "dup-1", p_body: "once" }),
    ]);
    const ids = [r1.data, r2.data].filter(Boolean);
    expect(new Set(ids).size).toBe(1);
    const { data: rows } = await admin().from("pending_messages").select("id").eq("conversation_id", conv).eq("client_send_id", "dup-1");
    expect(rows!.length).toBe(1);
  });

  it("holds contact details: revise with an explanation, no delivery, accept-revision delivers the redacted text", async () => {
    const { a, b, conv } = await chatting();
    const { data: pid } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "m-email", p_body: "email me at sam.jones@example.com and we can talk more" });
    await processPendingBatch();
    const { data: p } = await a.client.from("pending_messages").select("status, user_explanation, suggested_revision").eq("id", pid).single();
    expect(p!.status).toBe("revise");
    expect(p!.user_explanation).toMatch(/email/i);
    expect(p!.suggested_revision).not.toMatch(/@/);
    const { data: seen } = await b.client.from("approved_messages").select("*").eq("conversation_id", conv);
    expect(seen).toEqual([]);
    const { data: newId } = await a.client.rpc("accept_revision", { p_pending: pid });
    await processPendingBatch();
    const { data: seen2 } = await b.client.from("approved_messages").select("body").eq("conversation_id", conv);
    expect(seen2!.length).toBe(1);
    expect(seen2![0].body).toMatch(/\[email removed\]/);
    const { data: old } = await a.client.from("pending_messages").select("status").eq("id", pid).single();
    expect(old!.status).toBe("cancelled");
    expect(newId).toBeTruthy();
  });

  it("blocks threats and lets the sender appeal; admin can resolve", async () => {
    const { a, b, conv } = await chatting();
    const { data: pid } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "m-threat", p_body: "I will find you" });
    await processPendingBatch();
    const { data: p } = await a.client.from("pending_messages").select("status").eq("id", pid).single();
    expect(p!.status).toBe("blocked");
    const { data: seen } = await b.client.from("approved_messages").select("*").eq("conversation_id", conv);
    expect(seen).toEqual([]);
    const { data: appealId, error } = await a.client.rpc("file_appeal", { p_pending: pid, p_note: "it was a joke" });
    expect(error).toBeNull();
    const { data: bAppeals } = await b.client.from("appeals").select("*");
    expect(bAppeals).toEqual([]);
    expect(appealId).toBeTruthy();
  });

  it("keeps messages pending (never delivers) when the model is unavailable, then retries", async () => {
    const { a, b, conv } = await chatting();
    process.env.AI_PROVIDER = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;
    const { data: pid } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "m-outage", p_body: "are you still there?" });
    const r = await processPendingBatch();
    expect(r.deferred).toBe(1);
    const { data: p } = await a.client.from("pending_messages").select("status, attempts, last_error").eq("id", pid).single();
    expect(p!.status).toBe("pending");
    expect(p!.last_error).toMatch(/ANTHROPIC_API_KEY/);
    const { data: seen } = await b.client.from("approved_messages").select("*").eq("conversation_id", conv);
    expect(seen).toEqual([]);
    // sender can cancel while stuck
    await a.client.rpc("cancel_pending", { p_pending: pid });
    const { data: p2 } = await a.client.from("pending_messages").select("status").eq("id", pid).single();
    expect(p2!.status).toBe("cancelled");
    // service back: a new message flows
    process.env.AI_PROVIDER = "mock";
    await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "m-after", p_body: "back now" });
    await admin().from("pending_messages").update({ next_attempt_at: new Date().toISOString() }).eq("conversation_id", conv);
    await processPendingBatch();
    const { data: seen2 } = await b.client.from("approved_messages").select("body").eq("conversation_id", conv);
    expect(seen2!.map((m) => m.body)).toEqual(["back now"]);
  });

  it("falls into human review after repeated failures", async () => {
    const { a, conv } = await chatting();
    process.env.AI_PROVIDER = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;
    const { data: pid } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "m-review", p_body: "hello?" });
    for (let i = 0; i < 7; i++) {
      await admin().from("pending_messages").update({ next_attempt_at: new Date().toISOString() }).eq("id", pid);
      await processPendingBatch();
    }
    process.env.AI_PROVIDER = "mock";
    const { data: p } = await a.client.from("pending_messages").select("status, user_explanation").eq("id", pid).single();
    expect(p!.status).toBe("review");
    expect(p!.user_explanation).toMatch(/human review/i);
  });

  it("rate-limits sends", async () => {
    const { a, conv } = await chatting();
    let limited = false;
    for (let i = 0; i < 35; i++) {
      const { error } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: `rl-${i}`, p_body: "x" });
      if (error?.code === "P0002") { limited = true; break; }
    }
    expect(limited).toBe(true);
    // leave no backlog for later tests
    await admin().from("pending_messages").update({ status: "cancelled" }).eq("conversation_id", conv).eq("status", "pending");
  });

  it("fires a mid-chat question after enough active chat, and backs off", async () => {
    const { a, b, conv } = await chatting();
    await admin().from("conversations").update({ last_activity_at: new Date(Date.now() - 100_000).toISOString(), active_seconds_since_question: 80 }).eq("id", conv);
    await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "mid-1", p_body: "yeah" });
    await processPendingBatch(); // delta capped at quiet_cap (60) → 140 >= 90 → due
    const { data: qs } = await b.client.from("conversation_questions").select("phase, status").eq("conversation_id", conv).eq("phase", "mid");
    expect(qs!.length).toBe(1);
    const { data: c } = await admin().from("conversations").select("question_gap_seconds, active_seconds_since_question").eq("id", conv).single();
    expect(c!.question_gap_seconds).toBe(180);
    expect(c!.active_seconds_since_question).toBe(0);
  });
});

describe("leaving, blocking, reporting", () => {
  it("leaving ends the conversation, cancels pending, and notifies the other person", async () => {
    const a = await user("l-a", LEFT);
    const b = await user("l-b", RIGHT);
    const conv = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    const { data: c } = await b.client.from("conversations").select("status, end_reason").eq("id", conv).single();
    expect(c).toEqual({ status: "ended", end_reason: "left" });
    const { data: n } = await b.client.from("notifications").select("kind").eq("kind", "conversation_ended");
    expect(n!.length).toBe(1);
  });

  it("blocking ends the conversation and prevents future matching; reports are reviewer-only", async () => {
    const a = await user("b-a", LEFT);
    const b = await user("b-b", RIGHT);
    const conv = await openConversation(a, b);
    const { data: rid } = await a.client.rpc("report_peer", { p_conversation: conv, p_reason: "harassment", p_details: "rude", p_message_ids: [], p_also_block: true });
    expect(rid).toBeTruthy();
    const { data: c } = await admin().from("conversations").select("status, end_reason").eq("id", conv).single();
    expect(c).toEqual({ status: "ended", end_reason: "blocked" });
    const { data: bReports } = await b.client.from("reports").select("*");
    expect(bReports).toEqual([]);
    const { data: blocks } = await a.client.from("blocks").select("*");
    expect(blocks).toEqual([]); // not client-readable
    const { pairs } = await matchPair(a, b);
    expect(pairs).toBe(0);
    const { error } = await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    expect(error?.code).toBe("P0001");
  });
});

describe("reflection and reconnection", () => {
  it("records private decisions; connects only when both say yes; reconnection reuses aliases", async () => {
    const a = await user("r-a", LEFT);
    const b = await user("r-b", RIGHT);
    const conv = await openConversation(a, b);
    const { data: aliases } = await a.client.from("participant_aliases").select("participant_id, alias").eq("conversation_id", conv);
    await a.client.rpc("leave_conversation", { p_conversation: conv });

    await a.client.from("session_reflections").insert({ conversation_id: conv, participant_id: aliases![0].participant_id, felt_understood: 4 }).then(() => {});
    const { data: d1 } = await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    expect(d1.status).toBe("recorded");
    const { data: bSees } = await b.client.from("connection_requests").select("*").eq("conversation_id", conv);
    expect(bSees).toEqual([]); // a's decision is private
    const { data: bConns } = await b.client.rpc("my_connections");
    expect(bConns).toEqual([]);
    const { data: d2 } = await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    expect(d2.status).toBe("connected");
    const { data: conns } = await a.client.rpc("my_connections");
    expect(conns!.length).toBe(1);
    const aAlias = aliases!.find((x) => x.participant_id === conns![0].my_alias)?.alias;
    void aAlias;
    expect(new Set(aliases!.map((x) => x.alias))).toEqual(new Set([conns![0].my_alias, conns![0].peer_alias]));

    // reconnect
    const { data: inv } = await a.client.rpc("request_reconnection", { p_connection: conns![0].connection_id });
    const { data: res } = await b.client.rpc("respond_invitation", { p_invitation: inv, p_accept: true });
    expect(res.status).toBe("opened");
    const { data: newAliases } = await b.client.from("participant_aliases").select("alias").eq("conversation_id", res.conversation_id);
    expect(new Set(newAliases!.map((x) => x.alias))).toEqual(new Set(aliases!.map((x) => x.alias)));
    const { data: c } = await admin().from("conversations").select("connection_id").eq("id", res.conversation_id).single();
    expect(c!.connection_id).toBe(conns![0].connection_id);
  });

  it("reconnect invitation state follows the server: pending → expired/declined → can invite again", async () => {
    const a = await user("ri-a", LEFT);
    const b = await user("ri-b", RIGHT);
    const conv = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    const { data: c0 } = await a.client.rpc("my_connections");
    const connId = c0![0].connection_id as string;
    // send
    const { data: inv1 } = await a.client.rpc("request_reconnection", { p_connection: connId });
    let { data: c1 } = await a.client.rpc("my_connections");
    expect(c1![0].pending_invitation_id).toBe(inv1);
    // expire → the Friends list (server data) no longer reports it
    await admin().from("match_invitations").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", inv1);
    ({ data: c1 } = await a.client.rpc("my_connections"));
    expect(c1![0].pending_invitation_id).toBeNull();
    await admin().rpc("expire_stale");
    // invite again, then the other side declines → cleared again
    const { data: inv2 } = await a.client.rpc("request_reconnection", { p_connection: connId });
    expect(inv2).not.toBe(inv1);
    await b.client.rpc("respond_invitation", { p_invitation: inv2, p_accept: false });
    const { data: c2 } = await a.client.rpc("my_connections");
    expect(c2![0].pending_invitation_id).toBeNull();
    // and a third invitation is accepted
    const { data: inv3 } = await a.client.rpc("request_reconnection", { p_connection: connId });
    const { data: r } = await b.client.rpc("respond_invitation", { p_invitation: inv3, p_accept: true });
    expect(r.status).toBe("opened");
  });

  it("friendship can be disabled by policy", async () => {
    const a = await user("f-a", LEFT);
    const b = await user("f-b", RIGHT);
    const conv = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await admin().from("policy_config").update({ value: false }).eq("key", "friendship_enabled");
    try {
      const { error } = await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
      expect(error?.message).toMatch(/not enabled/);
    } finally {
      await admin().from("policy_config").update({ value: true }).eq("key", "friendship_enabled");
    }
  });
});

describe("review regressions (2026-10-20)", () => {
  it("1: a client cannot move its participant row into another conversation", async () => {
    const a = await user("rv1-a", LEFT);
    const b = await user("rv1-b", RIGHT);
    const c = await user("rv1-c", LEFT);
    const d = await user("rv1-d", RIGHT);
    const conv1 = await openConversation(a, b);
    await resetQueue();
    const conv2 = await openConversation(c, d);
    const { data: mine } = await c.client.from("participants").select("id").eq("conversation_id", conv2).single();
    const r = await c.client.from("participants").update({ conversation_id: conv1 }).eq("id", mine!.id).select();
    expect(r.error ?? (r.data?.length === 0 ? null : new Error("updated"))).not.toBeNull();
    const { data: still } = await admin().from("participants").select("conversation_id").eq("id", mine!.id).single();
    expect(still!.conversation_id).toBe(conv2);
    const { data: msgs } = await c.client.from("conversation_questions").select("id").eq("conversation_id", conv1);
    expect(msgs).toEqual([]);
    // heartbeat via RPC still works
    const { error } = await c.client.rpc("heartbeat", { p_conversation: conv2 });
    expect(error).toBeNull();
  });

  it("2: one acceptance does not open the conversation", async () => {
    const a = await user("rv2-a", LEFT);
    const b = await user("rv2-b", RIGHT);
    const { invitationId } = await matchPair(a, b);
    const { data: r1 } = await a.client.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true });
    expect(r1.status).toBe("waiting_for_other");
    const { data: convs } = await admin().from("conversations").select("id").eq("invitation_id", invitationId);
    expect(convs).toEqual([]);
    const { data: r2 } = await b.client.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true });
    expect(r2.status).toBe("opened");
  });

  it("3: an approved custom answer is hidden from the peer until the question is revealed", async () => {
    const a = await user("rv3-a", LEFT);
    const b = await user("rv3-b", RIGHT);
    const conv = await openConversation(a, b);
    const qid = await generateNextQuestion(conv, "opening");
    const { data: pid } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "rv3-ans", p_body: "secret until both answer", p_kind: "answer", p_question: qid });
    await processPendingBatch();
    const { data: p } = await a.client.from("pending_messages").select("status").eq("id", pid).single();
    expect(p!.status).toBe("approved");
    const { data: peerView } = await b.client.from("approved_messages").select("body").eq("conversation_id", conv);
    expect(peerView).toEqual([]);
    const { data: ownView } = await a.client.from("approved_messages").select("body").eq("conversation_id", conv);
    expect(ownView!.map((m) => m.body)).toEqual(["secret until both answer"]);
    await b.client.rpc("answer_with_choice", { p_question: qid, p_choice: 0 });
    const { data: peerView2 } = await b.client.from("approved_messages").select("body").eq("conversation_id", conv);
    expect(peerView2!.map((m) => m.body)).toEqual(["secret until both answer"]);
  });

  it("4: retention clears custom answer text with the messages", async () => {
    const a = await user("rv4-a", LEFT);
    const b = await user("rv4-b", RIGHT);
    const conv = await openConversation(a, b);
    const qid = await generateNextQuestion(conv, "opening");
    await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "rv4-ans", p_body: "old words", p_kind: "answer", p_question: qid });
    await processPendingBatch();
    await b.client.rpc("answer_with_choice", { p_question: qid, p_choice: 0 });
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await admin().from("conversations").update({ ended_at: new Date(Date.now() - 31 * 86400_000).toISOString() }).eq("id", conv);
    const { data: out } = await admin().rpc("purge_retention");
    expect(out.custom_answers).toBeGreaterThanOrEqual(1);
    const { data: ans } = await admin().from("question_answers").select("custom_text").eq("conversation_id", conv);
    expect(ans!.every((x) => x.custom_text === null)).toBe(true);
    const { data: msgs } = await admin().from("approved_messages").select("id").eq("conversation_id", conv);
    expect(msgs).toEqual([]);
  });

  it("5: outsiders cannot cancel, appeal or accept a revision of someone else's message", async () => {
    const a = await user("rv5-a", LEFT);
    const b = await user("rv5-b", RIGHT);
    const c = await user("rv5-c", MIXED);
    const conv = await openConversation(a, b);
    await finishOpeningRound(a, b, conv, generateNextQuestion);
    const { data: pid } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "rv5-1", p_body: "email me at x@y.com" });
    await processPendingBatch();
    for (const who of [c, b]) {
      const r1 = await who.client.rpc("cancel_pending", { p_pending: pid });
      expect(r1.error?.code).toBe("42501");
      const r2 = await who.client.rpc("file_appeal", { p_pending: pid, p_note: "x" });
      expect(r2.error?.code).toBe("42501");
      const r3 = await who.client.rpc("accept_revision", { p_pending: pid });
      expect(r3.error?.code).toBe("42501");
    }
    const { data: p } = await admin().from("pending_messages").select("status").eq("id", pid).single();
    expect(p!.status).toBe("revise");
    const { error } = await a.client.rpc("accept_revision", { p_pending: pid });
    expect(error).toBeNull();
  });

  it("6: at most one open question per conversation, even under overlapping inserts", async () => {
    const a = await user("rv6-a", LEFT);
    const b = await user("rv6-b", RIGHT);
    const conv = await openConversation(a, b);
    const args = { p_conversation: conv, p_phase: "opening", p_text: "Q?", p_choices: ["a", "b", "c"], p_followup_a: null, p_followup_b: null, p_source: "bank", p_sensitive: false, p_rationale: "" };
    const results = await Promise.all([admin().rpc("insert_question", args), admin().rpc("insert_question", args), admin().rpc("insert_question", args)]);
    const ids = results.map((r) => r.data).filter(Boolean);
    expect(ids.length).toBe(1);
    const { data: open } = await admin().from("conversation_questions").select("id").eq("conversation_id", conv).eq("status", "open");
    expect(open!.length).toBe(1);
    const direct = await admin().from("conversation_questions").insert({ conversation_id: conv, seq: 99, phase: "opening", question_text: "dup", choices: ["a", "b", "c"], source: "bank" });
    expect(direct.error?.code).toBe("23505");
  });
});

describe("daily session, readiness, nonresponders, broadening", () => {
  it("joining and matching only happen while a session is open; reconnection too", async () => {
    const a = await user("ss-a", LEFT);
    const b = await user("ss-b", RIGHT);
    await closeSessions();
    const r = await a.client.rpc("join_queue", { p_notify_email: false });
    expect(r.error?.message).toMatch(/not open/);
    await openSessionNow();
    await a.client.rpc("join_queue", { p_notify_email: false });
    await b.client.rpc("join_queue", { p_notify_email: false });
    await closeSessions();
    const { data: pairs } = await admin().rpc("run_matching");
    expect(pairs).toBe(0);
    // closing the session closes unmatched entries
    await admin().rpc("expire_stale");
    const { data: reqs } = await admin().from("availability_requests").select("status").in("account_id", [a.id, b.id]);
    expect(reqs!.map((x) => x.status)).toEqual(["expired", "expired"]);
    // reconnection requests are refused while closed
    await openSessionNow();
    const conv = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    const { data: conns } = await a.client.rpc("my_connections");
    await closeSessions();
    const rr = await a.client.rpc("request_reconnection", { p_connection: conns![0].connection_id });
    expect(rr.error?.message).toMatch(/not open/);
    await openSessionNow();
    const { data: inv, error } = await a.client.rpc("request_reconnection", { p_connection: conns![0].connection_id });
    expect(error).toBeNull();
    const { data: row } = await admin().from("match_invitations").select("expires_at, created_at").eq("id", inv).single();
    expect(Date.parse(row!.expires_at) - Date.parse(row!.created_at)).toBeLessThanOrEqual(61_000);
  });

  it("an invitation created before closing stays valid until its 60-second deadline", async () => {
    const a = await user("ic-a", LEFT);
    const b = await user("ic-b", RIGHT);
    const { invitationId } = await matchPair(a, b);
    const { data: row } = await admin().from("match_invitations").select("expires_at, created_at").eq("id", invitationId).single();
    expect(Date.parse(row!.expires_at) - Date.parse(row!.created_at)).toBeLessThanOrEqual(61_000);
    await closeSessions();
    await a.client.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true });
    const { data: r } = await b.client.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true });
    expect(r.status).toBe("opened");
  });

  it("nonresponder is paused until ready; the responsive person keeps priority and avoids them", async () => {
    const a = await user("nr-a", LEFT);
    const b = await user("nr-b", RIGHT);
    const c = await user("nr-c", RIGHT);
    const { invitationId } = await matchPair(a, b);
    const { data: before } = await admin().from("availability_requests").select("created_at").eq("account_id", a.id).single();
    await a.client.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true });
    await admin().from("match_invitations").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", invitationId);
    await admin().rpc("expire_stale");
    const { data: ra } = await admin().from("availability_requests").select("status, paused_reason, created_at, avoid_account_ids").eq("account_id", a.id).single();
    const { data: rb } = await admin().from("availability_requests").select("status, paused_reason").eq("account_id", b.id).single();
    expect(ra).toMatchObject({ status: "waiting", paused_reason: null, created_at: before!.created_at });
    expect(ra!.avoid_account_ids).toContain(b.id);
    expect(rb).toMatchObject({ status: "waiting", paused_reason: "no_response" });
    // b stays paused even with heartbeats; a is not re-paired with b; c (newer) gets a instead
    await b.client.rpc("lobby_heartbeat");
    const { data: rb2 } = await admin().from("availability_requests").select("paused_reason").eq("account_id", b.id).single();
    expect(rb2!.paused_reason).toBe("no_response");
    await c.client.rpc("join_queue", { p_notify_email: false });
    await admin().rpc("run_matching");
    const { data: ips } = await admin().from("invitation_participants").select("account_id, match_invitations!inner(status)").eq("match_invitations.status", "pending");
    expect(new Set(ips!.map((x) => x.account_id))).toEqual(new Set([a.id, c.id]));
    // b confirms readiness → eligible again
    await b.client.rpc("confirm_ready");
    const { data: rb3 } = await admin().from("availability_requests").select("paused_reason, paused_at").eq("account_id", b.id).single();
    expect(rb3).toEqual({ paused_reason: null, paused_at: null });
  });

  it("stale presence pauses and a heartbeat resumes; a stale person is not matched", async () => {
    const a = await user("sp-a", LEFT);
    const b = await user("sp-b", RIGHT);
    await a.client.rpc("join_queue", { p_notify_email: false });
    await b.client.rpc("join_queue", { p_notify_email: false });
    await admin().from("availability_requests").update({ last_seen_at: new Date(Date.now() - 120_000).toISOString() }).eq("account_id", b.id);
    const { data: pairs } = await admin().rpc("run_matching");
    expect(pairs).toBe(0);
    await admin().rpc("expire_stale");
    const { data: rb } = await admin().from("availability_requests").select("paused_reason").eq("account_id", b.id).single();
    expect(rb!.paused_reason).toBe("stale");
    await b.client.rpc("lobby_heartbeat");
    const { data: pairs2 } = await admin().rpc("run_matching");
    expect(pairs2).toBe(1);
  });

  it("broadening needs explicit consent after the waiting thresholds and respects both people's preferences", async () => {
    const a = await user("br-a", { public_services: 0.5, high_income_taxes: 0.5, healthcare: 0.5, legal_immigration: 0.5, deportations: 0.5, abortion: 0, gun_purchases: 0.5, climate: 0.5 });
    const b = await user("br-b", { public_services: 0.75, high_income_taxes: 0.75, healthcare: 0.25, legal_immigration: 0.5, deportations: 0.5, abortion: 0, gun_purchases: 0.5, climate: 0.5 }); // score 0.09375
    await a.client.rpc("join_queue", { p_notify_email: false });
    await b.client.rpc("join_queue", { p_notify_email: false });
    expect((await admin().rpc("run_matching")).data).toBe(0); // 0.094 < 0.4
    const early = await a.client.rpc("set_broaden", { p_level: "relaxed" });
    expect(early.error?.message).toMatch(/not yet/);
    await admin().from("availability_requests").update({ created_at: new Date(Date.now() - 130_000).toISOString() }).in("account_id", [a.id, b.id]);
    expect((await a.client.rpc("set_broaden", { p_level: "relaxed" })).error).toBeNull();
    expect((await admin().rpc("run_matching")).data).toBe(0); // b still strict
    expect((await b.client.rpc("set_broaden", { p_level: "relaxed" })).error).toBeNull();
    expect((await admin().rpc("run_matching")).data).toBe(0); // 0.094 < 0.2 relaxed threshold
    expect((await a.client.rpc("set_broaden", { p_level: "any" })).error).toBeNull();
    expect((await admin().rpc("run_matching")).data).toBe(0); // b is only 'relaxed'
    expect((await b.client.rpc("set_broaden", { p_level: "any" })).error).toBeNull();
    expect((await admin().rpc("run_matching")).data).toBe(1);
    // reversible
    const c = await user("br-c", LEFT);
    await c.client.rpc("join_queue", { p_notify_email: false });
    await admin().from("availability_requests").update({ created_at: new Date(Date.now() - 130_000).toISOString() }).eq("account_id", c.id);
    await c.client.rpc("set_broaden", { p_level: "any" });
    expect((await c.client.rpc("set_broaden", { p_level: "strict" })).error).toBeNull();
    const { data: rc } = await admin().from("availability_requests").select("broaden").eq("account_id", c.id).single();
    expect(rc!.broaden).toBe("strict");
  });

  it("a block created after pairing stops the conversation from opening", async () => {
    const a = await user("bl-a", LEFT);
    const b = await user("bl-b", RIGHT);
    const { invitationId } = await matchPair(a, b);
    await admin().from("blocks").insert({ blocker_account_id: b.id, blocked_account_id: a.id });
    await a.client.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true });
    const { data: r } = await b.client.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true });
    expect(r.status).toBe("declined");
    const { data: convs } = await admin().from("conversations").select("id").eq("invitation_id", invitationId);
    expect(convs).toEqual([]);
  });
});

describe("reminders", () => {
  it("sends once per (account, session, device), retries failures up to 3 times, respects unsubscribe, and never after the session starts", async () => {
    const a = await user("rm-a", LEFT);
    await a.client.from("reminder_prefs").upsert({ account_id: a.id, push_enabled: true, email_enabled: false, mode: "daily", days: [0, 1, 2, 3, 4, 5, 6], minutes_before: 10 });
    const { data: subId } = await a.client.rpc("upsert_push_subscription", { p_endpoint: "https://fcm.googleapis.com/fcm/send/test-" + a.id, p_p256dh: "BPdummykeydummykeydummykey", p_auth: "authdummy", p_user_agent: "test" });
    const cfg = await getScheduleConfig();
    // a time inside the reminder window for the next configured session
    const nextStart = (await import("@/lib/schedule")).nextSessions(Date.now() + 3 * 3600_000, 1, cfg)[0].start;
    const at = nextStart - 9 * 60_000;
    expect(sessionDueForReminder(at, 10, cfg)?.start).toBe(nextStart);
    const r1 = await sendDueReminders(at);
    const r2 = await sendDueReminders(at); // overlapping run
    const { data: sends } = await admin().from("reminder_sends").select("status, attempts, target").eq("account_id", a.id);
    expect(sends!.length).toBe(1);
    expect(sends![0].target).toBe(subId);
    expect(["failed", "sent"]).toContain(sends![0].status); // bogus endpoint fails; a real one would send
    expect(r1.push.sent + r1.push.failed + r1.push.skipped + r1.push.disabled).toBe(1);
    expect(sends![0].attempts).toBeLessThanOrEqual(3);
    void r2;
    // bounded retries
    await sendDueReminders(at); await sendDueReminders(at); await sendDueReminders(at);
    const { data: sends2 } = await admin().from("reminder_sends").select("attempts").eq("account_id", a.id).single();
    expect(sends2!.attempts).toBeLessThanOrEqual(3);
    // stale: after the session started nothing is sent for it
    const b = await user("rm-b", RIGHT);
    await b.client.from("reminder_prefs").upsert({ account_id: b.id, push_enabled: true, mode: "daily", minutes_before: 10 });
    await b.client.rpc("upsert_push_subscription", { p_endpoint: "https://fcm.googleapis.com/fcm/send/test-" + b.id, p_p256dh: "BPdummykeydummykeydummykey", p_auth: "authdummy", p_user_agent: "test" });
    await sendDueReminders(nextStart + 1000);
    const { data: sendsB } = await admin().from("reminder_sends").select("id").eq("account_id", b.id);
    expect(sendsB).toEqual([]);
    // unsubscribe → no device → nothing sent
    await b.client.rpc("remove_push_subscription", { p_endpoint: "https://fcm.googleapis.com/fcm/send/test-" + b.id });
    await sendDueReminders(at);
    const { data: sendsB2 } = await admin().from("reminder_sends").select("id").eq("account_id", b.id);
    expect(sendsB2).toEqual([]);
    // 'next session only' fires only for that session
    const c = await user("rm-c", RIGHT);
    await c.client.from("reminder_prefs").upsert({ account_id: c.id, push_enabled: true, mode: "next", next_session_start: new Date(nextStart + 86_400_000).toISOString(), minutes_before: 10 });
    await c.client.rpc("upsert_push_subscription", { p_endpoint: "https://fcm.googleapis.com/fcm/send/test-" + c.id, p_p256dh: "BPdummykeydummykeydummykey", p_auth: "authdummy", p_user_agent: "test" });
    await sendDueReminders(at);
    const { data: sendsC } = await admin().from("reminder_sends").select("id").eq("account_id", c.id);
    expect(sendsC).toEqual([]);
    void DEFAULT_SCHEDULE;
  });

  it("a device endpoint belongs to one account at a time (shared devices)", async () => {
    const a = await user("sd-a", LEFT);
    const b = await user("sd-b", RIGHT);
    const ep = "https://fcm.googleapis.com/fcm/send/shared-" + a.id;
    await a.client.rpc("upsert_push_subscription", { p_endpoint: ep, p_p256dh: "k1k1k1k1k1k1", p_auth: "auth1", p_user_agent: "t" });
    await b.client.rpc("upsert_push_subscription", { p_endpoint: ep, p_p256dh: "k2k2k2k2k2k2", p_auth: "auth2", p_user_agent: "t" });
    const { data: rows } = await admin().from("push_subscriptions").select("account_id").eq("endpoint", ep);
    expect(rows!.map((r) => r.account_id)).toEqual([b.id]);
    const { data: aView } = await a.client.from("push_subscriptions").select("id").eq("endpoint", ep);
    expect(aView).toEqual([]);
  });
});

describe("third review regressions (2026-10-20)", () => {
  it("rejects push endpoints outside the known push services, at the database level", async () => {
    const a = await user("pe-a", LEFT);
    for (const ep of ["https://127.0.0.1/x", "http://fcm.googleapis.com/fcm/send/x", "https://example.com/push", "https://fcm.googleapis.com.evil.example/x", "https://user:pw@fcm.googleapis.com/x"]) {
      const r = await a.client.rpc("upsert_push_subscription", { p_endpoint: ep, p_p256dh: "kkkkkkkkkkkk", p_auth: "aaaaaa", p_user_agent: "t" });
      expect(r.error?.message, ep).toMatch(/unsupported push service/);
    }
    const ok = await a.client.rpc("upsert_push_subscription", { p_endpoint: "https://web.push.apple.com/abc" + a.id, p_p256dh: "kkkkkkkkkkkk", p_auth: "aaaaaa", p_user_agent: "t" });
    expect(ok.error).toBeNull();
  });

  it("a person already in a conversation cannot be put into a second one via Friends or matching", async () => {
    const a = await user("oc-a", LEFT);
    const b = await user("oc-b", RIGHT);
    const c = await user("oc-c", LEFT);
    // b and c become friends first
    const conv0 = await openConversation(b, c);
    await b.client.rpc("leave_conversation", { p_conversation: conv0 });
    await b.client.rpc("set_connection_decision", { p_conversation: conv0, p_decision: true });
    await c.client.rpc("set_connection_decision", { p_conversation: conv0, p_decision: true });
    const { data: conns } = await c.client.rpc("my_connections");
    await resetQueue();
    // b is now talking with a
    const conv1 = await openConversation(a, b);
    // c (free) invites b (busy): the sender check passes for c, b's acceptance must be refused
    const { data: inv, error } = await c.client.rpc("request_reconnection", { p_connection: conns![0].connection_id });
    expect(error).toBeNull();
    const { data: r } = await b.client.rpc("respond_invitation", { p_invitation: inv, p_accept: true });
    expect(r.status).toBe("declined");
    const { data: active } = await admin().from("participants").select("conversation_id, conversations!participants_conversation_id_fkey!inner(status)").eq("account_id", b.id).is("left_at", null).neq("conversations.status", "ended");
    expect(active!.map((x) => x.conversation_id)).toEqual([conv1]);
    // a busy sender cannot even send a Friends invitation
    const { error: e2 } = await b.client.rpc("request_reconnection", { p_connection: conns![0].connection_id });
    expect(e2?.message).toMatch(/already in a conversation/);
  });

  it("simultaneous acceptances of two invitations for the same person open only one conversation", async () => {
    const x = await user("sa-x", LEFT);
    const y = await user("sa-y", RIGHT);
    const z = await user("sa-z", RIGHT);
    // x is friends with both y and z (two past conversations)
    for (const f of [y, z]) {
      const cv = await openConversation(x, f);
      await x.client.rpc("leave_conversation", { p_conversation: cv });
      await x.client.rpc("set_connection_decision", { p_conversation: cv, p_decision: true });
      await f.client.rpc("set_connection_decision", { p_conversation: cv, p_decision: true });
      await resetQueue();
    }
    const { data: ys } = await y.client.rpc("my_connections");
    const { data: zs } = await z.client.rpc("my_connections");
    const { data: inv1 } = await y.client.rpc("request_reconnection", { p_connection: ys![0].connection_id });
    const { data: inv2 } = await z.client.rpc("request_reconnection", { p_connection: zs![0].connection_id });
    const [r1, r2] = await Promise.all([
      x.client.rpc("respond_invitation", { p_invitation: inv1, p_accept: true }),
      x.client.rpc("respond_invitation", { p_invitation: inv2, p_accept: true }),
    ]);
    const opened = [r1.data, r2.data].filter((d) => d?.status === "opened");
    expect(opened.length).toBe(1);
    const { data: active } = await admin().from("participants").select("conversation_id, conversations!participants_conversation_id_fkey!inner(status)").eq("account_id", x.id).is("left_at", null).neq("conversations.status", "ended");
    expect(active!.length).toBe(1);
  });

  it("the conversation_opened metric is recorded for both participants", async () => {
    const a = await user("mt-a", LEFT);
    const b = await user("mt-b", RIGHT);
    await openConversation(a, b);
    const { data: ev } = await admin().from("metric_events").select("account_id").eq("kind", "conversation_opened").in("account_id", [a.id, b.id]);
    expect(new Set(ev!.map((e) => e.account_id))).toEqual(new Set([a.id, b.id]));
  });
});

describe("stats and badges", () => {
  it("counts people/conversations only after a revealed question; peers see tiers only; third parties see nothing", async () => {
    const a = await user("st-a", LEFT);
    const b = await user("st-b", RIGHT);
    const c = await user("st-c", MIXED);
    const conv = await openConversation(a, b);
    let { data: s0 } = await a.client.rpc("my_stats");
    expect(s0[0]).toMatchObject({ people: 0, conversations: 0, friends: 0 });
    const qid = await generateNextQuestion(conv, "opening");
    await a.client.rpc("answer_with_choice", { p_question: qid, p_choice: 0 });
    await b.client.rpc("answer_with_choice", { p_question: qid, p_choice: 1 });
    ({ data: s0 } = await a.client.rpc("my_stats"));
    expect(s0[0]).toMatchObject({ people: 1, conversations: 1, friends: 0, full_rounds: 0 });
    const { data: pb } = await b.client.rpc("peer_badges", { p_conversation: conv });
    expect(pb[0]).toMatchObject({ people_tier: 1, friends_tier: 0, full_round: false, came_back: false });
    expect(Object.keys(pb[0])).not.toContain("people"); // no exact counts
    const { data: none } = await c.client.rpc("peer_badges", { p_conversation: conv });
    expect(none).toEqual([]);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    const { data: s1 } = await a.client.rpc("my_stats");
    expect(s1[0].friends).toBe(1);
  });
});

describe("housekeeping and deletion", () => {
  it("expire_stale notifies about an away partner and ends abandoned conversations", async () => {
    const a = await user("h-a", LEFT);
    const b = await user("h-b", RIGHT);
    const conv = await openConversation(a, b);
    await admin().from("participants").update({ last_seen_at: new Date(Date.now() - 130_000).toISOString() }).eq("conversation_id", conv).eq("account_id", a.id);
    await admin().rpc("expire_stale");
    const { data: n } = await b.client.from("notifications").select("kind").eq("kind", "partner_away");
    expect(n!.length).toBe(1);
    const { data: nA } = await a.client.from("notifications").select("kind").eq("kind", "partner_away");
    expect(nA).toEqual([]);
    await admin().from("participants").update({ last_seen_at: new Date(Date.now() - 700_000).toISOString() }).eq("conversation_id", conv).eq("account_id", a.id);
    await admin().rpc("expire_stale");
    const { data: c } = await admin().from("conversations").select("status, end_reason").eq("id", conv).single();
    expect(c).toEqual({ status: "ended", end_reason: "abandoned" });
  });

  it("deleting an account removes its data and ends live state; the peer's messages remain", async () => {
    const a = await user("d-a", LEFT);
    const b = await user("d-b", RIGHT);
    const conv = await openConversation(a, b);
    await finishOpeningRound(a, b, conv, generateNextQuestion);
    await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "d-1", p_body: "from a" });
    await b.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "d-2", p_body: "from b" });
    await processPendingBatch();
    await admin().rpc("prepare_account_deletion", { p_account: a.id });
    await admin().auth.admin.deleteUser(a.id);
    users.splice(users.indexOf(a), 1);
    const { data: prof } = await admin().from("profiles").select("*").eq("account_id", a.id);
    expect(prof).toEqual([]);
    const { data: parts } = await admin().from("participants").select("account_id").eq("conversation_id", conv);
    expect(parts!.map((p) => p.account_id)).toEqual([b.id]);
    const { data: msgs } = await admin().from("approved_messages").select("body").eq("conversation_id", conv);
    expect(msgs!.map((m) => m.body)).toEqual(["from b"]);
    const { data: c } = await admin().from("conversations").select("status").eq("id", conv).single();
    expect(c!.status).toBe("ended");
  });
});
