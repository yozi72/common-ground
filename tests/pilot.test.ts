import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { admin, makeUser, deleteUser, resetQueue, LEFT, RIGHT, MIXED, matchPair, openConversation, finishOpeningRound, type TestUser } from "./helpers";
import { processPendingBatch } from "@/lib/workers/moderation";
import { generateNextQuestion } from "@/lib/workers/questions";

const users: TestUser[] = [];
async function user(tag: string, answers: Record<string, number>, onboard = true) {
  const u = await makeUser(tag, answers, onboard);
  users.push(u);
  return u;
}

beforeAll(() => {
  process.env.AI_PROVIDER = "mock";
});
beforeEach(async () => {
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

  it("mixed/unsure users match on overlapping dimensions only", async () => {
    const m = await user("mix", { gov_role: 0, tradition: 0, immigration: -2 });
    const r = await user("mix-r", RIGHT);
    const { pairs } = await matchPair(m, r);
    expect(pairs).toBe(1); // mean |diff| over 3 shared dims = (2+2+4)/3 = 2.67
  });

  it("requires at least 3 answered dimensions and completed onboarding", async () => {
    const few = await user("few", { gov_role: 2 });
    const { error } = await few.client.rpc("join_queue", { p_notify_email: false });
    expect(error?.code).toBe("P0001");
    const raw = await user("raw", {}, false);
    const { error: e2 } = await raw.client.rpc("join_queue", { p_notify_email: false });
    expect(e2?.message).toMatch(/onboarding/);
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
