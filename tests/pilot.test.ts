import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { admin, makeUser, deleteUser, resetQueue, openSessionNow, closeSessions, LEFT, RIGHT, MIXED, FEW, KEYS, matchPair, openConversation, finishOpeningRound, type TestUser } from "./helpers";
import { buildQuestionInput } from "@/lib/workers/questions";
import { sendDueReminders } from "@/lib/workers/reminders";
import { sessionDueForReminder, DEFAULT_SCHEDULE } from "@/lib/schedule";
import { getScheduleConfig } from "@/lib/schedule-config";
import { processPendingBatch } from "@/lib/workers/moderation";
import { sendFriendMessagePushes } from "@/lib/workers/friend-push";
import { sendQueuedEmails, PermanentEmailError } from "@/lib/workers/email";
import { processPendingById, processPendingBatch as processBatchWithDeadline } from "@/lib/workers/moderation";
import { runTick } from "@/lib/workers/tick";
import { Deadline } from "@/lib/workers/deadline";
import { GET as unsubGet, POST as unsubPost } from "@/app/api/reminders/unsubscribe/route";
import { unsubscribeToken } from "@/lib/unsubscribe";
import { actionablePending, latestMessages, olderMessages } from "@/lib/chat-queries";
import { mergeMessages, olderCursor } from "@/lib/chat-history";
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
  it("records private decisions; connects only when both say yes; the friend thread reuses aliases", async () => {
    const a = await user("r-a", LEFT);
    const b = await user("r-b", RIGHT);
    const conv = await openConversation(a, b);
    const { data: aliases } = await a.client.from("participant_aliases").select("participant_id, alias").eq("conversation_id", conv);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    const { data: d1 } = await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    expect(d1.status).toBe("recorded");
    const { data: bSees } = await b.client.from("connection_requests").select("*").eq("conversation_id", conv);
    expect(bSees).toEqual([]); // a's decision is private
    const { data: bConns } = await b.client.rpc("friend_threads_overview");
    expect(bConns).toEqual([]);
    const { data: d2 } = await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    expect(d2.status).toBe("connected");
    const { data: conns } = await a.client.rpc("friend_threads_overview");
    expect(conns!.length).toBe(1);
    expect(conns![0].conversation_id).toBeNull(); // no thread until someone opens it
    const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
    const { data: newAliases } = await b.client.from("participant_aliases").select("alias").eq("conversation_id", tid);
    expect(new Set(newAliases!.map((x) => x.alias))).toEqual(new Set(aliases!.map((x) => x.alias)));
    const { data: c } = await admin().from("conversations").select("kind, status, connection_id").eq("id", tid).single();
    expect(c).toEqual({ kind: "friend", status: "chatting", connection_id: conns![0].connection_id });
  });

  it("exactly one thread per friendship, even when both open it at once; removal ends it for both", async () => {
    const a = await user("ri-a", LEFT);
    const b = await user("ri-b", RIGHT);
    const conv = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    const { data: c0 } = await a.client.rpc("friend_threads_overview");
    const connId = c0![0].connection_id as string;
    const results = await Promise.all([
      a.client.rpc("open_friend_thread", { p_connection: connId }),
      b.client.rpc("open_friend_thread", { p_connection: connId }),
      a.client.rpc("open_friend_thread", { p_connection: connId }),
    ]);
    expect(results.every((r) => !r.error)).toBe(true);
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    const { data: threads } = await admin().from("conversations").select("id").eq("connection_id", connId).eq("kind", "friend");
    expect(threads!.length).toBe(1);
    // a stranger cannot open it
    const c = await user("ri-c", MIXED);
    const { error } = await c.client.rpc("open_friend_thread", { p_connection: connId });
    expect(error?.code).toBe("42501");
    // removal: no new messages, history readable, thread ended with reason
    await a.client.rpc("remove_friend", { p_connection: connId });
    const { error: e2 } = await b.client.rpc("submit_message", { p_conversation: results[0].data, p_client_send_id: "x1", p_body: "still there?" });
    expect(e2?.message).toMatch(/ended/);
    const { data: cv } = await admin().from("conversations").select("status, end_reason").eq("id", results[0].data).single();
    expect(cv).toEqual({ status: "ended", end_reason: "unfriended" });
    const { error: e3 } = await a.client.rpc("open_friend_thread", { p_connection: connId });
    expect(e3).toBeNull(); // existing thread id is still returned for history
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
    // friend chats are independent of session hours
    await openSessionNow();
    const conv = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    const { data: conns } = await a.client.rpc("friend_threads_overview");
    await closeSessions();
    const { data: tid, error } = await a.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
    expect(error).toBeNull();
    const { error: e2 } = await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "closed-1", p_body: "hi from outside the hour" });
    expect(e2).toBeNull();
    await openSessionNow();
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

  it("friend threads never count as the active conversation; live matches stay exclusive", async () => {
    const a = await user("oc-a", LEFT);
    const b = await user("oc-b", RIGHT);
    const c = await user("oc-c", LEFT);
    const conv0 = await openConversation(b, c);
    await b.client.rpc("leave_conversation", { p_conversation: conv0 });
    await b.client.rpc("set_connection_decision", { p_conversation: conv0, p_decision: true });
    await c.client.rpc("set_connection_decision", { p_conversation: conv0, p_decision: true });
    const { data: conns } = await c.client.rpc("friend_threads_overview");
    const { data: tid } = await c.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
    await c.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "f1", p_body: "hey" });
    await resetQueue();
    // b, with an open friend thread, can still join the queue and get a live conversation
    const conv1 = await openConversation(a, b);
    const { data: live } = await admin().from("participants").select("conversation_id, conversations!participants_conversation_id_fkey!inner(status, kind)").eq("account_id", b.id).is("left_at", null).neq("conversations.status", "ended").eq("conversations.kind", "live");
    expect(live!.map((x) => x.conversation_id)).toEqual([conv1]);
    // while in the live conversation, b can still message the friend thread
    const { error } = await b.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "f2", p_body: "one sec, in a conversation" });
    expect(error).toBeNull();
    // but cannot join the queue for a second live one
    const r = await b.client.rpc("join_queue", { p_notify_email: false });
    expect(r.error?.message).toMatch(/already in a conversation/);
  });

  it("simultaneous acceptances of two live invitations for the same person open only one conversation, without deadlock, and requeue the other partner", async () => {
    const x = await user("sa-x", LEFT);
    const y = await user("sa-y", RIGHT);
    const z = await user("sa-z", RIGHT);
    // craft two pending invitations for x (x+y and x+z) as the matcher could under a race
    const mk = async (other: TestUser) => {
      await x.client.rpc("join_queue", { p_notify_email: false }); await other.client.rpc("join_queue", { p_notify_email: false });
      const { data: inv } = await admin().from("match_invitations").insert({ kind: "match", expires_at: new Date(Date.now() + 60_000).toISOString() }).select("id").single();
      const { data: rx } = await admin().from("availability_requests").select("id").eq("account_id", x.id).in("status", ["waiting", "invited"]).single();
      const { data: ro } = await admin().from("availability_requests").select("id").eq("account_id", other.id).in("status", ["waiting", "invited"]).single();
      await admin().from("invitation_participants").insert([{ invitation_id: inv!.id, account_id: x.id, availability_request_id: rx!.id }, { invitation_id: inv!.id, account_id: other.id, availability_request_id: ro!.id }]);
      await admin().from("availability_requests").update({ status: "invited", matched_invitation_id: inv!.id }).in("id", [rx!.id, ro!.id]);
      return inv!.id as string;
    };
    const inv1 = await mk(y);
    const inv2 = await mk(z);
    await y.client.rpc("respond_invitation", { p_invitation: inv1, p_accept: true });
    await z.client.rpc("respond_invitation", { p_invitation: inv2, p_accept: true });
    const [r1, r2] = await Promise.all([
      x.client.rpc("respond_invitation", { p_invitation: inv1, p_accept: true }),
      x.client.rpc("respond_invitation", { p_invitation: inv2, p_accept: true }),
    ]);
    expect(r1.error).toBeNull(); expect(r2.error).toBeNull(); // no deadlock / no 500
    const opened = [r1.data, r2.data].filter((d) => d?.status === "opened");
    expect(opened.length).toBe(1);
    const { data: active } = await admin().from("participants").select("conversation_id, conversations!participants_conversation_id_fkey!inner(status)").eq("account_id", x.id).is("left_at", null).neq("conversations.status", "ended");
    expect(active!.length).toBe(1);
    // the partner of the losing invitation is back to waiting, not stranded as 'invited'
    const loser = opened[0].conversation_id;
    const { data: parts } = await admin().from("participants").select("account_id").eq("conversation_id", loser);
    const other = [y, z].find((u) => !parts!.some((p) => p.account_id === u.id))!;
    const { data: ro } = await admin().from("availability_requests").select("status, matched_invitation_id").eq("account_id", other.id).order("created_at", { ascending: false }).limit(1).single();
    expect(ro!.status).toBe("waiting");
    expect(ro!.matched_invitation_id).toBeNull();
    const { data: strandedAll } = await admin().from("availability_requests").select("id").eq("status", "invited").in("account_id", [x.id, y.id, z.id]);
    expect(strandedAll).toEqual([]);
  });

  it("metrics: one live conversation = 2 joins, 2 successful participants, 1 conversation, 100% within 2 min", async () => {
    const a = await user("mt-a", LEFT);
    const b = await user("mt-b", RIGHT);
    const since = new Date().toISOString();
    const conv = await openConversation(a, b);
    const { data: ev } = await admin().from("metric_events").select("kind, account_id, meta").gte("created_at", since).in("kind", ["queue_join", "conversation_opened", "conversation_started"]);
    expect(ev!.filter((e) => e.kind === "queue_join").length).toBe(2);
    expect(new Set(ev!.filter((e) => e.kind === "conversation_opened").map((e) => e.account_id))).toEqual(new Set([a.id, b.id]));
    const started = ev!.filter((e) => e.kind === "conversation_started");
    expect(started.length).toBe(1);
    expect(started[0].meta.conversation_id).toBe(conv);
    const { data: m } = await admin().rpc("metrics_summary", { p_since: since });
    expect(m.queue_joins).toBe(2); expect(m.successful_participants).toBe(2); expect(m.conversations_opened).toBe(1); expect(Number(m.started_within_2min_pct)).toBe(100);
    // a friend thread with messages adds nothing to matching metrics
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    const { data: conns } = await a.client.rpc("friend_threads_overview");
    const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "m1", p_body: "hi" });
    await processPendingBatch();
    const { data: m2 } = await admin().rpc("metrics_summary", { p_since: since });
    expect(m2.conversations_opened).toBe(1); expect(m2.successful_participants).toBe(2);
  });

  it("friend chat lifecycle: offline delivery, moderation, unread counts, mute consent, retention", async () => {
    const a = await user("fl-a", LEFT);
    const b = await user("fl-b", RIGHT);
    const conv = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    const { data: conns } = await a.client.rpc("friend_threads_overview");
    const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
    // a writes while b is "offline" (no heartbeat, no presence); pending is invisible to b and not counted
    const { data: pid } = await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "fl-1", p_body: "Hope your week got better." });
    let { data: ov } = await b.client.rpc("friend_threads_overview");
    expect(ov![0].unread).toBe(0);
    const { data: bPending } = await b.client.from("pending_messages").select("id").eq("conversation_id", tid);
    expect(bPending).toEqual([]);
    await processPendingBatch();
    ({ data: ov } = await b.client.rpc("friend_threads_overview"));
    expect(ov![0].unread).toBe(1);
    const { data: total } = await b.client.rpc("friend_unread_total");
    expect(total).toBe(1);
    // a contact detail is held, never delivered, never counted
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "fl-2", p_body: "text me 415-555-0142" });
    await processPendingBatch();
    ({ data: ov } = await b.client.rpc("friend_threads_overview"));
    expect(ov![0].unread).toBe(1);
    // reading clears; a's own messages never count for a
    await b.client.rpc("mark_thread_read", { p_conversation: tid });
    ({ data: ov } = await b.client.rpc("friend_threads_overview"));
    expect(ov![0].unread).toBe(0);
    const { data: ovA } = await a.client.rpc("friend_threads_overview");
    expect(ovA![0].unread).toBe(0);
    // push consent is separate: no friend_push_enabled → nothing queued even with session reminders on
    await b.client.from("reminder_prefs").upsert({ account_id: b.id, push_enabled: true, email_enabled: true, mode: "daily" });
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "fl-3", p_body: "another" });
    await processPendingBatch();
    let { data: q } = await admin().from("push_queue").select("id").eq("account_id", b.id);
    expect(q).toEqual([]);
    await b.client.from("reminder_prefs").update({ friend_push_enabled: true }).eq("account_id", b.id);
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "fl-4", p_body: "and another" });
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "fl-5", p_body: "and one more" });
    await processPendingBatch();
    ({ data: q } = await admin().from("push_queue").select("id").eq("account_id", b.id));
    expect(q!.length).toBe(1); // flood guard: one per thread per 10 minutes
    // mute stops queueing
    await admin().from("thread_reads").update({ last_push_at: null }).eq("conversation_id", tid).eq("account_id", b.id);
    await b.client.rpc("set_thread_muted", { p_conversation: tid, p_muted: true });
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "fl-6", p_body: "muted?" });
    await processPendingBatch();
    ({ data: q } = await admin().from("push_queue").select("id").eq("account_id", b.id));
    expect(q!.length).toBe(1);
    // retention: chat history is kept while the chat is open, however old (changed 2026-10-21)
    await admin().from("approved_messages").update({ created_at: new Date(Date.now() - 31 * 86400_000).toISOString() }).eq("pending_message_id", pid);
    await admin().rpc("purge_retention");
    const { data: left } = await admin().from("approved_messages").select("pending_message_id").eq("conversation_id", tid);
    expect(left!.some((m) => m.pending_message_id === pid)).toBe(true);
    const { data: cv } = await admin().from("conversations").select("status").eq("id", tid).single();
    expect(cv!.status).toBe("chatting");
    // block: pending message cancelled, thread ended, nothing delivered
    await b.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "fl-7", p_body: "about to be blocked" });
    await a.client.rpc("block_peer", { p_conversation: tid });
    const { data: p7 } = await admin().from("pending_messages").select("status").eq("client_send_id", "fl-7").single();
    expect(p7!.status).toBe("cancelled");
    const { data: cv2 } = await admin().from("conversations").select("status, end_reason").eq("id", tid).single();
    expect(cv2).toEqual({ status: "ended", end_reason: "blocked" });
  });

  it("friend threads are untouched by presence and abandonment housekeeping", async () => {
    const a = await user("fh-a", LEFT);
    const b = await user("fh-b", RIGHT);
    const conv = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    const { data: conns } = await a.client.rpc("friend_threads_overview");
    const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
    await admin().from("participants").update({ last_seen_at: new Date(Date.now() - 3 * 86400_000).toISOString() }).eq("conversation_id", tid);
    await admin().rpc("expire_stale");
    const { data: cv } = await admin().from("conversations").select("status, partner_away_notified_at").eq("id", tid).single();
    expect(cv).toEqual({ status: "chatting", partner_away_notified_at: null });
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

describe("fourth review regressions (2026-10-20)", () => {
  async function befriend(tagA: string, tagB: string) {
    const a = await user(tagA, LEFT);
    const b = await user(tagB, RIGHT);
    const conv = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    const { data: conns } = await a.client.rpc("friend_threads_overview");
    const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
    return { a, b, conv, connectionId: conns![0].connection_id as string, tid: tid as string };
  }

  it("blocking closes the open question; the blocked person can neither answer it nor see the hidden answer", async () => {
    const a = await user("bq-a", LEFT);
    const b = await user("bq-b", RIGHT);
    const conv = await openConversation(a, b);
    const qid = await generateNextQuestion(conv, "opening");
    await a.client.rpc("answer_with_choice", { p_question: qid, p_choice: 2 });
    await a.client.rpc("block_peer", { p_conversation: conv });
    const { data: q } = await admin().from("conversation_questions").select("status, revealed_at").eq("id", qid).single();
    expect(q).toEqual({ status: "closed", revealed_at: null });
    const r = await b.client.rpc("answer_with_choice", { p_question: qid, p_choice: 0 });
    expect(r.error?.code).toBe("P0001");
    const s = await b.client.rpc("skip_question", { p_question: qid });
    expect(s.error?.code).toBe("P0001");
    const { data: seen } = await b.client.from("question_answers").select("*").eq("question_id", qid);
    expect(seen).toEqual([]);
    const { data: q2 } = await admin().from("conversation_questions").select("status, revealed_at").eq("id", qid).single();
    expect(q2!.revealed_at).toBeNull();
  });

  it("leaving closes the open question too, and a custom answer approved afterwards never reveals", async () => {
    const a = await user("lq-a", LEFT);
    const b = await user("lq-b", RIGHT);
    const conv = await openConversation(a, b);
    const qid = await generateNextQuestion(conv, "opening");
    await a.client.rpc("answer_with_choice", { p_question: qid, p_choice: 1 });
    const { data: pid } = await b.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "lq-1", p_body: "my own answer", p_kind: "answer", p_question: qid });
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await processPendingBatch();
    const { data: p } = await admin().from("pending_messages").select("status").eq("id", pid).single();
    expect(p!.status).toBe("cancelled");
    const { data: q } = await admin().from("conversation_questions").select("status, revealed_at").eq("id", qid).single();
    expect(q).toEqual({ status: "closed", revealed_at: null });
    const { data: seen } = await b.client.from("question_answers").select("participant_id").eq("question_id", qid);
    expect(seen!.length).toBe(1); // only b's own row
  });

  it("a removed friendship needs a fresh yes from both before it comes back; then the thread returns", async () => {
    const { a, b, conv, connectionId, tid } = await befriend("rf-a", "rf-b");
    await a.client.rpc("remove_friend", { p_connection: connectionId });
    let { data: cn } = await admin().from("connections").select("status").eq("id", connectionId).single();
    expect(cn!.status).toBe("ended");
    // old decisions are revoked: neither person sees one any more
    const { data: mineB } = await b.client.from("connection_requests").select("decision").eq("conversation_id", conv);
    expect(mineB).toEqual([]);
    // one person alone cannot restore it
    const { data: r1 } = await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    expect(r1.status).toBe("recorded");
    ({ data: cn } = await admin().from("connections").select("status").eq("id", connectionId).single());
    expect(cn!.status).toBe("ended");
    let { data: th } = await admin().from("conversations").select("status").eq("id", tid).single();
    expect(th!.status).toBe("ended");
    const open = await a.client.rpc("open_friend_thread", { p_connection: connectionId });
    expect(open.data).toBe(tid); // history only; sending is refused
    const send = await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "rf-x", p_body: "still there?" });
    expect(send.error?.code).toBe("P0001");
    // the other person's fresh yes restores the friendship and its thread
    const { data: r2 } = await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    expect(r2.status).toBe("connected");
    ({ data: cn } = await admin().from("connections").select("status").eq("id", connectionId).single());
    expect(cn!.status).toBe("active");
    ({ data: th } = await admin().from("conversations").select("status, end_reason").eq("id", tid).single());
    expect(th).toEqual({ status: "chatting", end_reason: null });
    const ok = await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "rf-y", p_body: "welcome back" });
    expect(ok.error).toBeNull();
  });

  it("a block revokes consent as well; the thread stays ended even if both say yes", async () => {
    const { a, b, conv, connectionId, tid } = await befriend("rb-a", "rb-b");
    await a.client.rpc("block_peer", { p_conversation: tid });
    const { data: r } = await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    expect(r.status).toBe("recorded");
    const { data: cn } = await admin().from("connections").select("status").eq("id", connectionId).single();
    expect(cn!.status).toBe("ended");
  });

  it("queued friend alerts are dropped by later mute, read, opt-out, removal; failures retry then give up", async () => {
    const { a, b, connectionId, tid } = await befriend("pq-a", "pq-b");
    await b.client.from("reminder_prefs").upsert({ account_id: b.id, friend_push_enabled: true });
    const resetGuard = () => admin().from("thread_reads").update({ last_push_at: null }).eq("conversation_id", tid).eq("account_id", b.id);
    const queued = async () => (await admin().from("push_queue").select("id, status, last_error, attempts, next_attempt_at").eq("account_id", b.id).order("created_at")).data!;
    const sendAndQueue = async (id: string) => { await resetGuard(); await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: id, p_body: "hello " + id }); await processPendingBatch(); };

    await sendAndQueue("pq-1");
    expect((await queued()).map((r) => r.status)).toEqual(["queued"]);
    await b.client.rpc("set_thread_muted", { p_conversation: tid, p_muted: true });
    expect((await queued()).map((r) => [r.status, r.last_error])).toEqual([["cancelled", "muted"]]);
    await b.client.rpc("set_thread_muted", { p_conversation: tid, p_muted: false });

    await sendAndQueue("pq-2");
    expect((await queued())[1].status).toBe("queued");
    await b.client.rpc("mark_thread_read", { p_conversation: tid });
    expect((await queued())[1]).toMatchObject({ status: "cancelled", last_error: "read" });

    // re-check at claim time: opted out after queueing → skipped, never sent
    await sendAndQueue("pq-3");
    await b.client.from("reminder_prefs").update({ friend_push_enabled: false }).eq("account_id", b.id);
    let { data: claimed } = await admin().rpc("claim_push_queue", { p_limit: 10 });
    expect(claimed).toEqual([]);
    expect((await queued())[2]).toMatchObject({ status: "skipped", last_error: "opted out" });
    await b.client.from("reminder_prefs").update({ friend_push_enabled: true }).eq("account_id", b.id);

    // a warranted alert is claimed; a transient failure goes back to the queue with backoff, then fails for good
    await sendAndQueue("pq-4");
    ({ data: claimed } = await admin().rpc("claim_push_queue", { p_limit: 10 }));
    expect(claimed!.length).toBe(1);
    const id = claimed![0].id as string;
    let { data: st } = await admin().rpc("fail_push_queue", { p_id: id, p_error: "push 502" });
    expect(st).toBe("queued");
    const row = (await queued()).find((r) => r.id === id)!;
    expect(row.attempts).toBe(1);
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    ({ data: claimed } = await admin().rpc("claim_push_queue", { p_limit: 10 }));
    expect(claimed).toEqual([]); // not due yet
    await admin().from("push_queue").update({ next_attempt_at: new Date().toISOString() }).eq("id", id);
    ({ data: claimed } = await admin().rpc("claim_push_queue", { p_limit: 10 }));
    expect(claimed!.map((r: { id: string }) => r.id)).toEqual([id]);
    await admin().rpc("fail_push_queue", { p_id: id, p_error: "push 502" });
    // a failure report for a row that is no longer claimed changes nothing (fifth review)
    ({ data: st } = await admin().rpc("fail_push_queue", { p_id: id, p_error: "stale report" }));
    expect(st).toBe("queued");
    await admin().from("push_queue").update({ next_attempt_at: new Date().toISOString() }).eq("id", id);
    await admin().rpc("claim_push_queue", { p_limit: 10 });
    ({ data: st } = await admin().rpc("fail_push_queue", { p_id: id, p_error: "push 502" }));
    expect(st).toBe("failed");
    // a stale claim (worker died) is reclaimed after 10 minutes
    await sendAndQueue("pq-5");
    ({ data: claimed } = await admin().rpc("claim_push_queue", { p_limit: 10 }));
    const stale = claimed![0].id as string;
    ({ data: claimed } = await admin().rpc("claim_push_queue", { p_limit: 10 }));
    expect(claimed).toEqual([]);
    await admin().from("push_queue").update({ claimed_at: new Date(Date.now() - 11 * 60_000).toISOString() }).eq("id", stale);
    ({ data: claimed } = await admin().rpc("claim_push_queue", { p_limit: 10 }));
    expect(claimed!.map((r: { id: string }) => r.id)).toEqual([stale]);
    // removal cancels whatever is still pending
    await admin().from("push_queue").update({ status: "queued", next_attempt_at: new Date().toISOString() }).eq("id", stale);
    await a.client.rpc("remove_friend", { p_connection: connectionId });
    expect((await queued()).find((r) => r.id === stale)).toMatchObject({ status: "cancelled", last_error: "friendship ended" });
  });

  it("the read marker only advances to what was loaded, and never backwards", async () => {
    const { a, b, tid } = await befriend("rm-a", "rm-b");
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "rm-1", p_body: "first" });
    await processPendingBatch();
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "rm-2", p_body: "second" });
    await processPendingBatch();
    const { data: ms } = await admin().from("approved_messages").select("created_at").eq("conversation_id", tid).order("created_at");
    expect(ms!.length).toBe(2);
    const unread = async () => (await b.client.rpc("friend_unread_total")).data as number;
    expect(await unread()).toBe(2);
    await b.client.rpc("mark_thread_read", { p_conversation: tid, p_up_to: ms![0].created_at });
    expect(await unread()).toBe(1);
    await b.client.rpc("mark_thread_read", { p_conversation: tid, p_up_to: new Date(Date.now() - 86400_000).toISOString() });
    expect(await unread()).toBe(1); // never backwards
    await b.client.rpc("mark_thread_read", { p_conversation: tid, p_up_to: ms![1].created_at });
    expect(await unread()).toBe(0);
    // a bound in the future can't mark messages that don't exist yet as read
    await b.client.rpc("mark_thread_read", { p_conversation: tid, p_up_to: new Date(Date.now() + 3600_000).toISOString() });
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "rm-3", p_body: "third" });
    await processPendingBatch();
    expect(await unread()).toBe(1);
  });
});

describe("fifth review regressions (2026-10-21)", () => {
  async function befriend(tagA: string, tagB: string) {
    const a = await user(tagA, LEFT);
    const b = await user(tagB, RIGHT);
    const conv = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    const { data: conns } = await a.client.rpc("friend_threads_overview");
    const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
    return { a, b, conv, connectionId: conns![0].connection_id as string, tid: tid as string };
  }
  const sendAndQueue = async (a: TestUser, tid: string, bId: string, id: string) => {
    await admin().from("thread_reads").update({ last_push_at: null }).eq("conversation_id", tid).eq("account_id", bId);
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: id, p_body: "hello " + id });
    await processPendingBatch();
    const { data } = await admin().from("push_queue").select("id, status, deliveries, attempts, next_attempt_at").eq("account_id", bId).order("created_at", { ascending: false }).limit(1).single();
    return data!;
  };

  it("'Give us a question' is refused in a live session, and a mid question cannot derail the opening round", async () => {
    const a = await user("gq-a", LEFT);
    const b = await user("gq-b", RIGHT);
    const conv = await openConversation(a, b);
    // nine opening questions answered by both
    for (let i = 0; i < 9; i++) {
      const qid = await generateNextQuestion(conv, "opening");
      await a.client.rpc("answer_with_choice", { p_question: qid, p_choice: 0 });
      await b.client.rpc("answer_with_choice", { p_question: qid, p_choice: 1 });
    }
    const r = await a.client.rpc("can_request_question", { p_conversation: conv });
    expect(r.error?.code).toBe("P0001");                                   // friend threads only
    await expect(generateNextQuestion(conv, "mid")).rejects.toThrow(/opening/); // server refuses the phase
    const { data: qs } = await admin().from("conversation_questions").select("phase, status").eq("conversation_id", conv).order("seq");
    expect(qs!.length).toBe(9);
    expect(qs!.every((q) => q.phase === "opening" && q.status === "revealed")).toBe(true);
    const qid = await generateNextQuestion(conv, "opening");
    await a.client.rpc("answer_with_choice", { p_question: qid, p_choice: 0 });
    await b.client.rpc("answer_with_choice", { p_question: qid, p_choice: 1 });
    const { data: c } = await admin().from("conversations").select("status").eq("id", conv).single();
    expect(c!.status).toBe("chatting");
    await expect(generateNextQuestion(conv, "opening")).rejects.toThrow(/mid/); // and no opening questions once chatting
  });

  it("a friend thread accepts the question action and only mid questions", async () => {
    const { a, tid } = await befriend("gf-a", "gf-b");
    const { data: ok } = await a.client.rpc("can_request_question", { p_conversation: tid });
    expect(ok).toBe(true);
    await expect(generateNextQuestion(tid, "opening")).rejects.toThrow(/mid/);
    const qid = await generateNextQuestion(tid, "mid");
    expect(qid).toBeTruthy();
    const { data: again } = await a.client.rpc("can_request_question", { p_conversation: tid });
    expect(again).toBe(false); // one open at a time
  });

  it("push: one device succeeds, one fails transiently → only the failed one is retried; expired ones are disabled", async () => {
    const { a, b, tid } = await befriend("pd-a", "pd-b");
    await b.client.from("reminder_prefs").upsert({ account_id: b.id, friend_push_enabled: true });
    const epA = `https://fcm.googleapis.com/fcm/send/dev-a-${b.id}`, epB = `https://fcm.googleapis.com/fcm/send/dev-b-${b.id}`;
    for (const ep of [epA, epB]) await b.client.rpc("upsert_push_subscription", { p_endpoint: ep, p_p256dh: "kkkkkkkkkkkk", p_auth: "aaaaaa", p_user_agent: "t" });
    const row = await sendAndQueue(a, tid, b.id, "pd-1");
    expect(row.status).toBe("queued");
    const calls: string[] = [];
    let failA = true;
    const send = async (sub: { endpoint: string }) => { calls.push(sub.endpoint); if (sub.endpoint === epA && failA) throw Object.assign(new Error("Service Unavailable"), { statusCode: 503 }); };
    let out = await sendFriendMessagePushes(10, { configured: true, send });
    expect(out).toMatchObject({ sent: 0, retried: 1, failed: 0 });
    let { data: q } = await admin().from("push_queue").select("status, attempts, deliveries, next_attempt_at").eq("id", row.id).single();
    expect(q!.status).toBe("queued");
    expect(q!.attempts).toBe(1);
    const { data: subs } = await admin().from("push_subscriptions").select("id, endpoint").in("endpoint", [epA, epB]);
    const idOf = (ep: string) => subs!.find((s) => s.endpoint === ep)!.id;
    expect(q!.deliveries[idOf(epB)].status).toBe("sent");
    expect(q!.deliveries[idOf(epA)]).toMatchObject({ status: "failed", attempts: 1 });
    expect(calls.sort()).toEqual([epA, epB].sort());
    // retry: due now, device A recovers, device B is not sent again
    await admin().from("push_queue").update({ next_attempt_at: new Date().toISOString() }).eq("id", row.id);
    failA = false; calls.length = 0;
    out = await sendFriendMessagePushes(10, { configured: true, send });
    expect(out).toMatchObject({ sent: 1, retried: 0 });
    expect(calls).toEqual([epA]);
    ({ data: q } = await admin().from("push_queue").select("status, deliveries").eq("id", row.id).single());
    expect(q!.status).toBe("sent");
    expect(q!.deliveries[idOf(epA)].status).toBe("sent");
    // an expired subscription (410) is disabled; the other device still counts as delivered
    const row2 = await sendAndQueue(a, tid, b.id, "pd-2");
    out = await sendFriendMessagePushes(10, { configured: true, send: async (sub) => { if (sub.endpoint === epA) throw Object.assign(new Error("Gone"), { statusCode: 410 }); } });
    expect(out).toMatchObject({ sent: 1 });
    const { data: gone } = await admin().from("push_subscriptions").select("disabled_at").eq("endpoint", epA).single();
    expect(gone!.disabled_at).not.toBeNull();
    ({ data: q } = await admin().from("push_queue").select("status, deliveries").eq("id", row2.id).single());
    expect(q!.status).toBe("sent");
    expect(q!.deliveries[idOf(epA)].status).toBe("gone");
  });

  it("push: a mute (or read/removal/block) after the claim stops the remaining devices and is never overwritten by 'sent'", async () => {
    const { a, b, tid } = await befriend("pc-a", "pc-b");
    await b.client.from("reminder_prefs").upsert({ account_id: b.id, friend_push_enabled: true });
    const eps = [1, 2].map((n) => `https://fcm.googleapis.com/fcm/send/dev-${n}-${b.id}`);
    for (const ep of eps) await b.client.rpc("upsert_push_subscription", { p_endpoint: ep, p_p256dh: "kkkkkkkkkkkk", p_auth: "aaaaaa", p_user_agent: "t" });
    const row = await sendAndQueue(a, tid, b.id, "pc-1");
    let calls = 0;
    // the first device send succeeds, but while it is in flight the recipient mutes the thread
    const out = await sendFriendMessagePushes(10, { configured: true, send: async () => { calls++; await b.client.rpc("set_thread_muted", { p_conversation: tid, p_muted: true }); } });
    expect(calls).toBe(1);
    expect(out).toMatchObject({ sent: 0, cancelled: 1 });
    const { data: q } = await admin().from("push_queue").select("status, last_error").eq("id", row.id).single();
    expect(q).toEqual({ status: "cancelled", last_error: "muted" });
    // a stale failure report for a row that is no longer claimed changes nothing either
    const { data: st } = await admin().rpc("fail_push_queue", { p_id: row.id, p_error: "late" });
    expect(st).toBe("cancelled");
    const { data: q2 } = await admin().from("push_queue").select("status, attempts").eq("id", row.id).single();
    expect(q2).toEqual({ status: "cancelled", attempts: 0 });
  });

  it("push: an obsolete alert (read before the worker got to it) is skipped at send time", async () => {
    const { a, b, tid } = await befriend("po-a", "po-b");
    await b.client.from("reminder_prefs").upsert({ account_id: b.id, friend_push_enabled: true });
    await b.client.rpc("upsert_push_subscription", { p_endpoint: `https://fcm.googleapis.com/fcm/send/dev-${b.id}`, p_p256dh: "kkkkkkkkkkkk", p_auth: "aaaaaa", p_user_agent: "t" });
    const row = await sendAndQueue(a, tid, b.id, "po-1");
    // claimed by a worker that then stalls; meanwhile the recipient reads the thread
    const { data: claimed } = await admin().rpc("claim_push_queue", { p_limit: 10 });
    expect(claimed!.map((r: { id: string }) => r.id)).toEqual([row.id]);
    await b.client.rpc("mark_thread_read", { p_conversation: tid });
    const { data: q } = await admin().from("push_queue").select("status").eq("id", row.id).single();
    expect(q!.status).toBe("cancelled");
    const { data: state } = await admin().rpc("recheck_push_queue", { p_id: row.id, p_claimed_at: claimed![0].claimed_at });
    expect(state).toBe("cancelled");
  });

  it("a fresh 'revise' stays reachable behind more than 1,000 completed send records; history pages by (created_at, id)", async () => {
    const { a, b, tid } = await befriend("lp-a", "lp-b");
    const { data: pid } = await a.client.rpc("my_participant_id", { p_conversation: tid });
    const rows = Array.from({ length: 1001 }, (_, i) => ({ conversation_id: tid, sender_participant_id: pid, client_send_id: `old-${i}`, kind: "chat", body: `old ${i}`, status: "approved", created_at: new Date(Date.now() - (2000 - i) * 1000).toISOString() }));
    for (let i = 0; i < rows.length; i += 500) { const { error } = await admin().from("pending_messages").insert(rows.slice(i, i + 500)); expect(error).toBeNull(); }
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "lp-needs-action", p_body: "call me on 415-555-0199" });
    await processPendingBatch();
    const { data: act } = await actionablePending(a.client, tid);
    expect(act!.map((p) => [p.client_send_id, p.status])).toEqual([["lp-needs-action", "revise"]]);
    // 450 delivered messages (some with identical timestamps): newest page, then older pages, nothing lost
    const t0 = Date.now() - 100_000;
    const msgs = Array.from({ length: 450 }, (_, i) => ({ conversation_id: tid, sender_participant_id: pid, kind: "chat", body: `m${i}`, created_at: new Date(t0 + Math.floor(i / 3) * 1000).toISOString() }));
    for (let i = 0; i < msgs.length; i += 150) { const { error } = await admin().from("approved_messages").insert(msgs.slice(i, i + 150)); expect(error).toBeNull(); }
    let have = mergeMessages([], (await latestMessages(b.client, tid)).data!);
    expect(have.length).toBe(200);
    let pages = 0;
    for (;;) {
      const page = (await olderMessages(b.client, tid, olderCursor(have)!)).data!;
      have = mergeMessages(have, page); pages++;
      if (page.length < 200) break;
    }
    expect(pages).toBe(2);
    expect(have.length).toBe(450);
    expect(new Set(have.map((m) => m.id)).size).toBe(450);
    for (let i = 1; i < have.length; i++) expect(have[i - 1].created_at <= have[i].created_at).toBe(true);
  });

  it("viewing an ended friendship's history marks it read", async () => {
    const { a, b, connectionId, tid } = await befriend("eh-a", "eh-b");
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "eh-1", p_body: "before the end" });
    await processPendingBatch();
    await a.client.rpc("remove_friend", { p_connection: connectionId });
    expect((await b.client.rpc("friend_unread_total")).data).toBe(1);
    // the client bounds the mark to the newest message it displayed (a server timestamp, never the device clock)
    const { data: newest } = await b.client.from("approved_messages").select("created_at").eq("conversation_id", tid).order("created_at", { ascending: false }).limit(1).single();
    const { error } = await b.client.rpc("mark_thread_read", { p_conversation: tid, p_up_to: newest!.created_at });
    expect(error).toBeNull();
    expect((await b.client.rpc("friend_unread_total")).data).toBe(0);
  });
});

describe("audit regressions (2026-10-21)", () => {
  const HUMAN = { p_categories: ["human_review"], p_user_explanation: null, p_suggested_revision: null, p_confidence: 1, p_detector_hits: [], p_provider: "human", p_model: null, p_raw_valid: true, p_latency_ms: null };
  const AUTO = { p_categories: [], p_user_explanation: null, p_suggested_revision: null, p_confidence: 0.9, p_detector_hits: [], p_provider: "mock", p_model: "mock", p_raw_valid: true, p_latency_ms: 5 };
  async function befriend(tagA: string, tagB: string) {
    const a = await user(tagA, LEFT);
    const b = await user(tagB, RIGHT);
    const conv = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    const { data: conns } = await a.client.rpc("friend_threads_overview");
    const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
    return { a, b, conv, connectionId: conns![0].connection_id as string, tid: tid as string };
  }
  async function chattingPair(tagA: string, tagB: string) {
    const a = await user(tagA, LEFT);
    const b = await user(tagB, RIGHT);
    const conv = await openConversation(a, b);
    await finishOpeningRound(a, b, conv, generateNextQuestion);
    return { a, b, conv };
  }

  it("1. queue rows never expose other people's account ids; safe queue state still reads", async () => {
    const a = await user("av-a", LEFT);
    await a.client.rpc("join_queue", { p_notify_email: false });
    const safe = await a.client.from("availability_requests").select("id, status, expires_at, notify_email, created_at, paused_reason, broaden, session_start").in("status", ["waiting", "invited"]).maybeSingle();
    expect(safe.error).toBeNull();
    expect(safe.data?.status).toBe("waiting");
    const leak = await a.client.from("availability_requests").select("avoid_account_ids").eq("account_id", a.id);
    expect(leak.error?.code).toBe("42501");
    const star = await a.client.from("availability_requests").select("*").eq("account_id", a.id);
    expect(star.error?.code).toBe("42501");
    await a.client.rpc("leave_queue");
  });

  it("2. onboarding, political answers and consent cannot be written directly; validated paths still work", async () => {
    const u = await user("dw-a", LEFT, false);
    const r1 = await u.client.from("accounts").update({ onboarding_complete: true }).eq("id", u.id);
    expect(r1.error?.code).toBe("42501");
    const { data: acct } = await admin().from("accounts").select("onboarding_complete").eq("id", u.id).single();
    expect(acct!.onboarding_complete).toBe(false);
    const r2 = await u.client.from("profiles").update({ political_answers: { public_services: 5 } }).eq("account_id", u.id);
    expect(r2.error?.code).toBe("42501");
    const r3 = await u.client.from("consent_events").insert({ account_id: u.id, kind: "terms", version: "v9", granted: true });
    expect(r3.error?.code).toBe("42501");
    const r4 = await u.client.rpc("complete_onboarding", { p_age_band: "25-34", p_region: "midwest", p_community: "suburban", p_life_context: [], p_share_context: false, p_political_answers: { public_services: 5 }, p_political_nonanswers: {}, p_issue_priorities: [], p_questionnaire_version: 2, p_terms_version: "test" });
    expect(r4.error?.code).toBe("P0001");
    const r5 = await u.client.rpc("record_consent", { p_kind: "terms", p_version: "v1", p_granted: true });
    expect(r5.error?.code).toBe("P0001");
    // the intended paths
    const ok1 = await u.client.rpc("complete_onboarding", { p_age_band: "25-34", p_region: "midwest", p_community: "suburban", p_life_context: ["parent"], p_share_context: false, p_political_answers: LEFT, p_political_nonanswers: {}, p_issue_priorities: [], p_questionnaire_version: 2, p_terms_version: "test" });
    expect(ok1.error).toBeNull();
    const ok2 = await u.client.from("profiles").update({ timezone_override: "Europe/Berlin" }).eq("account_id", u.id);
    expect(ok2.error).toBeNull();
    const ok3 = await u.client.rpc("record_consent", { p_kind: "friend_push", p_version: "v1", p_granted: true });
    expect(ok3.error).toBeNull();
    const { data: prof } = await u.client.from("profiles").select("timezone_override, political_answers, age_band").eq("account_id", u.id).single();
    expect(prof).toMatchObject({ timezone_override: "Europe/Berlin", age_band: "25-34" });
    expect(prof!.political_answers).toEqual(LEFT);
    const { data: consents } = await u.client.from("consent_events").select("kind").eq("account_id", u.id).order("created_at");
    expect(consents!.map((c) => c.kind).sort()).toEqual(["friend_push", "profile_context", "terms"]);
    await u.client.from("reminder_prefs").upsert({ account_id: u.id, email_enabled: true });
    const { data: rp } = await u.client.from("reminder_prefs").select("email_enabled").eq("account_id", u.id).single();
    expect(rp!.email_enabled).toBe(true);
  });

  it("3. the live 'leave' action refuses friend threads", async () => {
    const { a, tid } = await befriend("lv-a", "lv-b");
    const r = await a.client.rpc("leave_conversation", { p_conversation: tid });
    expect(r.error?.code).toBe("P0001");
    const { data: c } = await admin().from("conversations").select("status").eq("id", tid).single();
    expect(c!.status).toBe("chatting");
  });

  it("4. simultaneous 'yes' decisions create exactly one friendship; repeats, removal and block races stay consistent", async () => {
    const a = await user("sy-a", LEFT);
    const b = await user("sy-b", RIGHT);
    const conv = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    const [ra, rb] = await Promise.all([
      a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true }),
      b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true }),
    ]);
    expect(ra.error).toBeNull(); expect(rb.error).toBeNull();
    expect([ra.data.status, rb.data.status]).toContain("connected");
    const conns = async () => (await admin().from("connections").select("id, status").or(`account_a.eq.${a.id},account_b.eq.${a.id}`)).data!;
    expect(await conns()).toHaveLength(1);
    // repeated submissions
    const [r2, r3] = await Promise.all([a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true }), a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true })]);
    expect(r2.data.status).toBe("connected"); expect(r3.data.status).toBe("connected");
    expect(await conns()).toHaveLength(1);
    // acceptance racing with removal: one connection, ended, never two unrevoked consents while ended
    const cid = (await conns())[0].id;
    await Promise.all([a.client.rpc("remove_friend", { p_connection: cid }), b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true })]);
    let cs = await conns();
    expect(cs).toHaveLength(1);
    expect(cs[0].status).toBe("ended");
    const { data: live } = await admin().from("connection_requests").select("participant_id").eq("conversation_id", conv).is("revoked_at", null);
    expect(live!.length).toBeLessThan(2);
    // restoration after removal needs both again
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    cs = await conns();
    expect(cs).toEqual([{ id: cid, status: "active" }]);
    // acceptance racing with a block
    const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: cid });
    await Promise.all([a.client.rpc("block_peer", { p_conversation: tid }), b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true })]);
    cs = await conns();
    expect(cs).toEqual([{ id: cid, status: "ended" }]);
    const again = await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    expect(again.data.status).toBe("recorded");
    expect((await conns())[0].status).toBe("ended");
  });

  it("5. moderation claims: stale, overlapping, cancelled and human-decided outcomes never overwrite each other; one delivery", async () => {
    const { a, b, conv } = await chattingPair("mc-a", "mc-b");
    const { data: pid } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "mc-1", p_body: "slow one" });
    // worker A claims, then its lease expires (slow model call); worker B reclaims
    let { data: ca } = await admin().rpc("claim_pending", { p_limit: 10 });
    const tokenA = ca![0].claim_token as string;
    expect(tokenA).toBeTruthy();
    const none = await admin().rpc("claim_pending", { p_limit: 10 });
    expect(none.data).toEqual([]);                                                  // leased: not claimable
    await admin().from("pending_messages").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", pid);
    ({ data: ca } = await admin().rpc("claim_pending", { p_limit: 10 }));
    const tokenB = ca![0].claim_token as string;
    expect(tokenB).not.toBe(tokenA);
    // A's late result is ignored; B's applies; nothing is delivered twice
    const late = await admin().rpc("apply_moderation_decision", { p_pending: pid, p_decision: "allow", ...AUTO, p_claim_token: tokenA });
    expect(late.data).toMatchObject({ skipped: true, reason: "stale claim" });
    const stale = await admin().rpc("defer_pending", { p_pending: pid, p_error: "late timeout", p_max_attempts: 6, p_claim_token: tokenA });
    expect(stale.error).toBeNull();
    const { data: still } = await admin().from("pending_messages").select("claim_token, status").eq("id", pid).single();
    expect(still).toEqual({ claim_token: tokenB, status: "pending" });
    const ok = await admin().rpc("apply_moderation_decision", { p_pending: pid, p_decision: "allow", ...AUTO, p_claim_token: tokenB });
    expect(ok.data.skipped).toBeUndefined();
    const dup = await admin().rpc("apply_moderation_decision", { p_pending: pid, p_decision: "allow", ...AUTO, p_claim_token: tokenB });
    expect(dup.data).toMatchObject({ skipped: true });
    const { data: delivered } = await b.client.from("approved_messages").select("id").eq("conversation_id", conv).eq("body", "slow one");
    expect(delivered).toHaveLength(1);
    // automated results need a token
    const { data: pid2 } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "mc-2", p_body: "second" });
    const noToken = await admin().rpc("apply_moderation_decision", { p_pending: pid2, p_decision: "allow", ...AUTO });
    expect(noToken.error?.code).toBe("P0001");
    // a human decision on a pending row wins over the automated result that arrives later
    ({ data: ca } = await admin().rpc("claim_pending", { p_limit: 10 }));
    const t2 = ca!.find((r: { id: string }) => r.id === pid2)!.claim_token as string;
    const human = await admin().rpc("apply_moderation_decision", { p_pending: pid2, p_decision: "block", ...HUMAN });
    expect(human.data.skipped).toBeUndefined();
    const lateAllow = await admin().rpc("apply_moderation_decision", { p_pending: pid2, p_decision: "allow", ...AUTO, p_claim_token: t2 });
    expect(lateAllow.data).toMatchObject({ skipped: true });
    const { data: p2 } = await admin().from("pending_messages").select("status").eq("id", pid2).single();
    expect(p2!.status).toBe("blocked");
    // cancellation while claimed
    const { data: pid3 } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "mc-3", p_body: "third" });
    ({ data: ca } = await admin().rpc("claim_pending", { p_limit: 10 }));
    const t3 = ca!.find((r: { id: string }) => r.id === pid3)!.claim_token as string;
    await a.client.rpc("cancel_pending", { p_pending: pid3 });
    const afterCancel = await admin().rpc("apply_moderation_decision", { p_pending: pid3, p_decision: "allow", ...AUTO, p_claim_token: t3 });
    expect(afterCancel.data).toMatchObject({ skipped: true });
    const { data: p3 } = await admin().from("pending_messages").select("status").eq("id", pid3).single();
    expect(p3!.status).toBe("cancelled");
    // exhausted retries hold for a person; the human review action still works without a token
    const { data: pid4 } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "mc-4", p_body: "fourth" });
    await admin().from("pending_messages").update({ attempts: 6 }).eq("id", pid4);
    ({ data: ca } = await admin().rpc("claim_pending", { p_limit: 10 }));
    const t4 = ca!.find((r: { id: string }) => r.id === pid4)!.claim_token as string;
    await admin().rpc("defer_pending", { p_pending: pid4, p_error: "outage", p_max_attempts: 6, p_claim_token: t4 });
    let { data: p4 } = await admin().from("pending_messages").select("status").eq("id", pid4).single();
    expect(p4!.status).toBe("review");
    const stillLate = await admin().rpc("apply_moderation_decision", { p_pending: pid4, p_decision: "allow", ...AUTO, p_claim_token: t4 });
    expect(stillLate.data).toMatchObject({ skipped: true });
    await admin().rpc("apply_moderation_decision", { p_pending: pid4, p_decision: "allow", ...HUMAN });
    ({ data: p4 } = await admin().from("pending_messages").select("status").eq("id", pid4).single());
    expect(p4!.status).toBe("approved");
    // immediate processing and the batch racing on the same message deliver it once
    const { data: pid5 } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "mc-5", p_body: "fifth" });
    await Promise.all([processPendingById(pid5), processBatchWithDeadline(20)]);
    const { data: d5 } = await b.client.from("approved_messages").select("id").eq("conversation_id", conv).eq("body", "fifth");
    expect(d5).toHaveLength(1);
  });

  it("6. the tick respects its deadline; unprocessed claims are released without consuming an attempt", async () => {
    const { a, conv } = await chattingPair("dl-a", "dl-b");
    const { data: pid } = await a.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: "dl-1", p_body: "later" });
    const out = await processBatchWithDeadline(20, Deadline.in(0));
    expect(out).toEqual({ processed: 0, deferred: 0, released: 0 });  // nothing claimed when there is no time
    const { data: claimed } = await admin().rpc("claim_pending", { p_limit: 10 });
    const row = claimed!.find((r: { id: string }) => r.id === pid)!;
    expect(row.attempts).toBe(1);
    const { data: released } = await admin().rpc("release_pending_claim", { p_id: pid, p_claim_token: row.claim_token });
    expect(released).toBe(true);
    const { data: p } = await admin().from("pending_messages").select("attempts, claim_token").eq("id", pid).single();
    expect(p).toEqual({ attempts: 0, claim_token: null });
    const { data: again } = await admin().rpc("claim_pending", { p_limit: 10 });
    expect(again!.map((r: { id: string }) => r.id)).toContain(pid);      // recoverable at once
    const { data: stale } = await admin().rpc("release_pending_claim", { p_id: pid, p_claim_token: row.claim_token });
    expect(stale).toBe(false);                                            // old token can't release the new claim
    // a tick with no budget skips its model-bound stages but reports what it skipped
    const tick = await runTick({ budgetMs: 10, source: "test" });
    expect(tick.moderation).toEqual({ skipped: "deadline" });
    expect(tick.questions).toEqual({ skipped: "deadline" });
  });

  it("7. matching racing with cancellation: cancelled entries are never resurrected or invited", async () => {
    for (let i = 0; i < 3; i++) {
      const a = await user(`mr-a${i}`, LEFT);
      const b = await user(`mr-b${i}`, RIGHT);
      await a.client.rpc("join_queue", { p_notify_email: false });
      await b.client.rpc("join_queue", { p_notify_email: false });
      await Promise.all([admin().rpc("run_matching"), a.client.rpc("leave_queue"), admin().rpc("run_matching")]);
      const { data: rows } = await admin().from("availability_requests").select("account_id, status, matched_invitation_id").in("account_id", [a.id, b.id]).order("created_at");
      const ra = rows!.find((r) => r.account_id === a.id)!;
      expect(["cancelled"]).toContain(ra.status);
      expect(ra.matched_invitation_id).toBeNull();
      const { data: pendingInv } = await admin().from("invitation_participants").select("invitation_id, match_invitations!inner(status)").eq("account_id", a.id).eq("match_invitations.status", "pending");
      expect(pendingInv).toEqual([]);
      const rb = rows!.find((r) => r.account_id === b.id)!;
      expect(["waiting", "invited", "expired"]).toContain(rb.status);
      await b.client.rpc("leave_queue");
      await resetQueue();
    }
  });

  it("9. email outbox: atomic claims, retries with backoff, permanent failures, cancellation and relevance", async () => {
    const a = await user("eo-a", LEFT);
    const b = await user("eo-b", RIGHT);
    await a.client.rpc("join_queue", { p_notify_email: true });
    await b.client.rpc("join_queue", { p_notify_email: true });
    const { data: pairs } = await admin().rpc("run_matching");
    expect(pairs).toBe(1);
    const rows = async () => (await admin().from("email_outbox").select("id, account_id, status, attempts, claim_token, next_attempt_at, last_error").in("account_id", [a.id, b.id]).order("created_at")).data!;
    expect((await rows()).map((r) => r.status)).toEqual(["queued", "queued"]);
    // two workers claiming at once get disjoint rows
    const [c1, c2] = await Promise.all([admin().rpc("claim_email_outbox", { p_limit: 1 }), admin().rpc("claim_email_outbox", { p_limit: 1 })]);
    const ids = [...c1.data!, ...c2.data!].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(2);
    expect((await rows()).every((r) => r.status === "claimed")).toBe(true);
    const nothing = await admin().rpc("claim_email_outbox", { p_limit: 10 });
    expect(nothing.data).toEqual([]);
    // expired lease → reclaimable; a transient failure goes back with backoff; a permanent one fails
    await admin().from("email_outbox").update({ claimed_until: new Date(Date.now() - 1000).toISOString() }).in("id", ids);
    let calls = 0;
    let out = await sendQueuedEmails(10, Deadline.none(), { configured: true, deliver: async ({ to }) => { calls++; if (to === a.email) throw new Error("smtp 421 try later"); throw new PermanentEmailError("mailbox gone"); } });
    expect(calls).toBe(2);
    expect(out).toMatchObject({ retried: 1, failed: 1, sent: 0 });
    const ra = (await rows()).find((r) => r.account_id === a.id)!;
    expect(ra.status).toBe("queued");
    expect(ra.attempts).toBe(2);
    expect(new Date(ra.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    // relevance: the invitation is declined → the queued notice is cancelled, never sent
    const { data: inv } = await a.client.from("invitation_participants").select("invitation_id").eq("account_id", a.id);
    await a.client.rpc("respond_invitation", { p_invitation: inv![0].invitation_id, p_accept: false });
    expect((await rows()).find((r) => r.account_id === a.id)!.status).toBe("cancelled");
    await admin().from("email_outbox").update({ next_attempt_at: new Date().toISOString() }).eq("id", ra.id);
    calls = 0;
    out = await sendQueuedEmails(10, Deadline.none(), { configured: true, deliver: async () => { calls++; return "mock"; } });
    expect(calls).toBe(0);
    // a fresh notice is delivered once; a finished row is never re-sent
    await resetQueue();
    await a.client.rpc("join_queue", { p_notify_email: true });
    await b.client.rpc("join_queue", { p_notify_email: true });
    await admin().rpc("run_matching");
    calls = 0;
    out = await sendQueuedEmails(10, Deadline.none(), { configured: true, deliver: async ({ id }) => { calls++; expect(id).toBeTruthy(); return "mock"; } });
    expect(out.sent).toBe(2);
    expect(calls).toBe(2);
    out = await sendQueuedEmails(10, Deadline.none(), { configured: true, deliver: async () => { calls++; return "mock"; } });
    expect(calls).toBe(2);
    await a.client.rpc("leave_queue"); await b.client.rpc("leave_queue");
  });

  it("10. ordinary users cannot read admin metrics or probe blocks", async () => {
    const a = await user("pr-a", LEFT);
    const b = await user("pr-b", RIGHT);
    expect((await a.client.rpc("metrics_summary", { p_since: "2026-01-01T00:00:00Z" })).error?.code).toBe("42501");
    expect((await a.client.rpc("admin_metrics", { p_since: "2026-01-01T00:00:00Z" })).error?.code).toBe("42501");
    expect((await a.client.rpc("is_blocked_either_way", { a: a.id, b: b.id })).error?.code).toBe("42501");
    expect((await a.client.rpc("cfg", { p_key: "x", p_default: {} })).error?.code).toBe("42501");
    expect((await a.client.rpc("take_rate_limit", { p_bucket: "send", p_limit: 1, p_window_seconds: 1 })).error?.code).toBe("42501");
    // what users legitimately call still works
    expect((await a.client.rpc("my_stats")).error).toBeNull();
    expect((await a.client.rpc("friend_unread_total")).error).toBeNull();
  });

  it("11. fetching the unsubscribe link changes nothing; confirming it turns email reminders off", async () => {
    const a = await user("un-a", LEFT);
    await a.client.from("reminder_prefs").upsert({ account_id: a.id, email_enabled: true });
    const t = unsubscribeToken(a.id);
    const prefetch = await unsubGet(new Request(`http://localhost/api/reminders/unsubscribe?t=${t}`));
    expect(prefetch.status).toBe(200);
    expect(await prefetch.text()).toContain("Stop reminder emails?");
    let { data: p } = await admin().from("reminder_prefs").select("email_enabled").eq("account_id", a.id).single();
    expect(p!.email_enabled).toBe(true);
    const bad = await unsubPost(new Request(`http://localhost/api/reminders/unsubscribe`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${t}x` }));
    expect(bad.status).toBe(400);
    ({ data: p } = await admin().from("reminder_prefs").select("email_enabled").eq("account_id", a.id).single());
    expect(p!.email_enabled).toBe(true);
    const confirm = await unsubPost(new Request(`http://localhost/api/reminders/unsubscribe`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(t)}` }));
    expect(confirm.status).toBe(200);
    ({ data: p } = await admin().from("reminder_prefs").select("email_enabled").eq("account_id", a.id).single());
    expect(p!.email_enabled).toBe(false);
    // RFC 8058 one-click: token in the URL, provider body
    await a.client.from("reminder_prefs").update({ email_enabled: true }).eq("account_id", a.id);
    const oneClick = await unsubPost(new Request(`http://localhost/api/reminders/unsubscribe?t=${t}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
    expect(oneClick.status).toBe(200);
    ({ data: p } = await admin().from("reminder_prefs").select("email_enabled").eq("account_id", a.id).single());
    expect(p!.email_enabled).toBe(false);
  });

  it("13. retention removes finished queue entries, old metrics, finished outbox rows and old reminder sends, never active ones", async () => {
    const a = await user("rt-a", LEFT);
    const old = new Date(Date.now() - 400 * 86400_000).toISOString();
    const ins = await admin().from("availability_requests").insert([
      { account_id: a.id, status: "cancelled", created_at: old, ended_at: old, expires_at: old },
      { account_id: a.id, status: "waiting", created_at: new Date().toISOString(), ended_at: null, expires_at: new Date(Date.now() + 3600_000).toISOString(), session_start: new Date().toISOString() },
    ]);
    expect(ins.error).toBeNull();
    const me = await admin().from("metric_events").insert([{ kind: "queue_join", created_at: old }, { kind: "worker_tick", created_at: new Date(Date.now() - 10 * 86400_000).toISOString() }, { kind: "queue_join", created_at: new Date().toISOString() }]);
    expect(me.error).toBeNull();
    await admin().from("email_outbox").insert([{ account_id: a.id, template: "invitation", status: "sent", created_at: old }, { account_id: a.id, template: "invitation", status: "queued", created_at: old }]);
    await admin().from("reminder_sends").insert({ account_id: a.id, session_start: old, channel: "email", target: "email", status: "sent", created_at: old });
    const { data: r } = await admin().rpc("purge_retention");
    expect(r.queue_entries).toBeGreaterThanOrEqual(1);
    expect(r.metric_events).toBeGreaterThanOrEqual(2);
    expect(r.outbox).toBeGreaterThanOrEqual(1);
    expect(r.reminder_sends).toBeGreaterThanOrEqual(1);
    const { data: q } = await admin().from("availability_requests").select("status").eq("account_id", a.id);
    expect(q!.map((x) => x.status)).toEqual(["waiting"]);
    const { data: o } = await admin().from("email_outbox").select("status").eq("account_id", a.id);
    expect(o!.map((x) => x.status)).toEqual(["queued"]);   // queued work is never purged
    await admin().from("availability_requests").delete().eq("account_id", a.id);
  });
});

describe("chats with two tiers (2026-10-21)", () => {
  async function keepTalking(tagA: string, tagB: string) {
    const a = await user(tagA, LEFT);
    const b = await user(tagB, RIGHT);
    const conv = await openConversation(a, b);
    await finishOpeningRound(a, b, conv, generateNextQuestion);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    const { data: conns } = await a.client.rpc("friend_threads_overview");
    const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
    return { a, b, conv, connectionId: conns![0].connection_id as string, tid: tid as string };
  }
  const overview = async (u: TestUser) => (await u.client.rpc("friend_threads_overview")).data![0];

  it("become friends: a visible request the other person accepts; both consents recorded; idempotent", async () => {
    const { a, b, connectionId } = await keepTalking("bf-a", "bf-b");
    expect(await overview(a)).toMatchObject({ tier: "chat", request_available: true, request_from_me: false, request_for_me: false });
    const { data: r1 } = await a.client.rpc("request_friend", { p_connection: connectionId });
    expect(r1).toBe("pending");
    expect(await overview(a)).toMatchObject({ request_from_me: true, request_available: false });
    expect(await overview(b)).toMatchObject({ request_for_me: true, request_available: false });
    const { data: again } = await a.client.rpc("request_friend", { p_connection: connectionId });
    expect(again).toBe("pending");
    const cross = await b.client.rpc("request_friend", { p_connection: connectionId });
    expect(cross.error?.code).toBe("P0001");                       // answer theirs instead
    const self = await a.client.rpc("respond_friend_request", { p_connection: connectionId, p_accept: true });
    expect(self.error?.code).toBe("P0001");                        // the asker can't accept their own request
    const { data: n } = await b.client.from("notifications").select("kind").eq("kind", "friend_request");
    expect(n!.length).toBe(1);
    const { data: r2 } = await b.client.rpc("respond_friend_request", { p_connection: connectionId, p_accept: true });
    expect(r2).toBe("friends");
    expect(await overview(a)).toMatchObject({ tier: "friend", request_from_me: false, request_for_me: false, request_available: false });
    expect((await overview(b)).friends_since).toBeTruthy();
    const { data: after } = await a.client.rpc("request_friend", { p_connection: connectionId });
    expect(after).toBe("friends");
    for (const u of [a, b]) {
      const { data: c } = await u.client.from("consent_events").select("granted").eq("kind", "contact_sharing");
      expect(c).toEqual([{ granted: true }]);
    }
    // no account ids anywhere in the overview
    expect(JSON.stringify(await overview(a))).not.toContain(b.id);
  });

  it("not now is private and starts a 7-day cooldown for the pair", async () => {
    const { a, b, connectionId } = await keepTalking("nn-a", "nn-b");
    await a.client.rpc("request_friend", { p_connection: connectionId });
    const { data: r } = await b.client.rpc("respond_friend_request", { p_connection: connectionId, p_accept: false });
    expect(r).toBe("declined");
    expect(await overview(a)).toMatchObject({ tier: "chat", request_from_me: false, request_available: false });
    const { data: tellA } = await a.client.from("notifications").select("kind").in("kind", ["friends", "friend_declined"]);
    expect(tellA).toEqual([]);                                      // the asker is not told
    expect((await a.client.rpc("request_friend", { p_connection: connectionId })).error?.code).toBe("P0002");
    expect((await b.client.rpc("request_friend", { p_connection: connectionId })).error?.code).toBe("P0002");
    await admin().from("connections").update({ friend_requested_at: new Date(Date.now() - 8 * 86400_000).toISOString() }).eq("id", connectionId);
    expect(await overview(b)).toMatchObject({ request_available: true });
    expect((await b.client.rpc("request_friend", { p_connection: connectionId })).data).toBe("pending");
  });

  it("contact details are held in a chat (with the unlock hint) and delivered between friends; abuse is still blocked", async () => {
    const { a, b, connectionId, tid } = await keepTalking("ct-a", "ct-b");
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "ct-1", p_body: "text me at 415-555-0101" });
    await processPendingBatch();
    const { data: held } = await a.client.from("pending_messages").select("status, user_explanation").eq("client_send_id", "ct-1").single();
    expect(held!.status).toBe("revise");
    expect(held!.user_explanation).toContain("Become friends");
    expect((await b.client.from("approved_messages").select("id").eq("conversation_id", tid)).data).toEqual([]);
    await a.client.rpc("request_friend", { p_connection: connectionId });
    await b.client.rpc("respond_friend_request", { p_connection: connectionId, p_accept: true });
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "ct-2", p_body: "I'm Alex, text me at 415-555-0101" });
    await processPendingBatch();
    const { data: seen } = await b.client.from("approved_messages").select("body").eq("conversation_id", tid);
    expect(seen!.map((m) => m.body)).toEqual(["I'm Alex, text me at 415-555-0101"]);
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "ct-3", p_body: "you people are vermin and I will find you" });
    await processPendingBatch();
    const { data: blocked } = await a.client.from("pending_messages").select("status").eq("client_send_id", "ct-3").single();
    expect(blocked!.status).toBe("blocked");
  });

  it("ending a chat and agreeing again starts over at the chat tier", async () => {
    const { a, b, conv, connectionId } = await keepTalking("rs-a", "rs-b");
    await a.client.rpc("request_friend", { p_connection: connectionId });
    await b.client.rpc("respond_friend_request", { p_connection: connectionId, p_accept: true });
    await a.client.rpc("remove_friend", { p_connection: connectionId });
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    expect(await overview(a)).toMatchObject({ status: "active", tier: "chat", request_available: true });
    expect((await overview(a)).friends_since).toBeNull();
  });

  it("recent conversations list the decision and reflection state, hide blocked ones, and point at the chat once both said yes", async () => {
    const a = await user("rc-a", LEFT);
    const b = await user("rc-b", RIGHT);
    const conv = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv });
    let { data: ra } = await a.client.rpc("my_recent_conversations");
    expect(ra).toHaveLength(1);
    expect(ra![0]).toMatchObject({ conversation_id: conv, my_decision: null, both_yes: false, reflection_done: false, connection_id: null, thread_id: null });
    expect(JSON.stringify(ra)).not.toContain(b.id);
    await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    ({ data: ra } = await a.client.rpc("my_recent_conversations"));
    expect(ra![0]).toMatchObject({ my_decision: true, both_yes: false });
    const { data: rb } = await b.client.rpc("my_recent_conversations");
    expect(rb![0]).toMatchObject({ my_decision: null, both_yes: false });   // a's yes is private
    await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
    ({ data: ra } = await a.client.rpc("my_recent_conversations"));
    expect(ra![0].both_yes).toBe(true);
    expect(ra![0].connection_id).toBeTruthy();
    const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: ra![0].connection_id });
    ({ data: ra } = await a.client.rpc("my_recent_conversations"));
    expect(ra![0].thread_id).toBe(tid);
    // a blocked conversation never shows up
    const c = await user("rc-c", MIXED);
    const conv2 = await openConversation(a, c);
    await c.client.rpc("block_peer", { p_conversation: conv2 });
    ({ data: ra } = await a.client.rpc("my_recent_conversations"));
    expect(ra!.map((r: { conversation_id: string }) => r.conversation_id)).toEqual([conv]);
    // older than 30 days drops off
    await admin().from("conversations").update({ ended_at: new Date(Date.now() - 31 * 86400_000).toISOString() }).eq("id", conv);
    ({ data: ra } = await a.client.rpc("my_recent_conversations"));
    expect(ra).toEqual([]);
  });

  it("history is kept while the chat is open, cleared on request for both, and purged 30 days after the chat ends", async () => {
    const { a, b, connectionId, tid } = await keepTalking("hk-a", "hk-b");
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "hk-1", p_body: "old but kept" });
    await processPendingBatch();
    await admin().from("approved_messages").update({ created_at: new Date(Date.now() - 200 * 86400_000).toISOString() }).eq("conversation_id", tid);
    await admin().rpc("purge_retention");
    expect((await b.client.from("approved_messages").select("id").eq("conversation_id", tid)).data).toHaveLength(1);
    const { data: n } = await b.client.rpc("clear_thread_history", { p_conversation: tid });
    expect(n).toBe(1);
    expect((await a.client.from("approved_messages").select("id").eq("conversation_id", tid)).data).toEqual([]);
    await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "hk-2", p_body: "after clearing" });
    await processPendingBatch();
    await a.client.rpc("remove_friend", { p_connection: connectionId });
    await admin().from("conversations").update({ ended_at: new Date(Date.now() - 31 * 86400_000).toISOString() }).eq("id", tid);
    const { data: purged } = await admin().rpc("purge_retention");
    expect(purged.friend_messages).toBeGreaterThanOrEqual(1);
    expect((await a.client.from("approved_messages").select("id").eq("conversation_id", tid)).data).toEqual([]);
  });
});
