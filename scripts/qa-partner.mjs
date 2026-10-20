#!/usr/bin/env node
// QA harness only — NOT part of the product. Plays the "other person" during a
// manual two-sided check by calling the same database RPCs the app's API routes
// call, as a real signed-in account. Usage (with .env.local exported):
//   node scripts/qa-partner.mjs            # join queue, accept, answer questions, chat
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(URL_, SVC, { auth: { persistSession: false } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const email = `qa-partner-${Date.now()}@test.local`;
const password = "qa-" + Math.random().toString(36).slice(2);
const { data: created, error: e0 } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (e0) throw e0;
const me = createClient(URL_, ANON, { auth: { persistSession: false } });
await me.auth.signInWithPassword({ email, password });
const myId = created.user.id;
await me.rpc("complete_onboarding", {
  p_age_band: "45-54", p_region: "south", p_community: "rural", p_life_context: ["veteran", "parent"],
  p_share_context: false, p_political_answers: { gov_role: 2, tradition: 2, immigration: 2, economy: 2, institutions: 2 }, p_terms_version: "pilot-v1",
});
log("partner account ready:", email);

const { error: ej } = await me.rpc("join_queue", { p_notify_email: false });
if (ej) throw ej;
log("joined the queue; waiting for an invitation…");

let invitationId = null;
while (!invitationId) {
  const { data } = await me.from("invitation_participants").select("invitation_id, decision, match_invitations!inner(status)").eq("account_id", myId).eq("match_invitations.status", "pending");
  if (data?.length) invitationId = data[0].invitation_id;
  else await sleep(2000);
}
log("invitation received; accepting in 5s");
await sleep(5000);
const { data: r } = await me.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true });
log("respond ->", r?.status);

let conv = r?.conversation_id ?? null;
while (!conv) {
  await sleep(2000);
  const { data } = await me.from("match_invitations").select("conversation_id, status").eq("id", invitationId).single();
  if (data?.conversation_id) conv = data.conversation_id;
  if (data?.status === "declined" || data?.status === "expired") { log("invitation", data.status); process.exit(0); }
}
log("conversation opened:", conv);

// answer every question a few seconds after it appears; chat once open
const answered = new Set();
let sentChat = 0;
for (;;) {
  await me.rpc("heartbeat", { p_conversation: conv });
  const { data: c } = await me.from("conversations").select("status").eq("id", conv).single();
  if (!c || c.status === "ended") { log("conversation ended"); break; }
  const { data: qs } = await me.from("conversation_questions").select("id, seq, question_text, choices, status").eq("conversation_id", conv).eq("status", "open");
  for (const q of qs ?? []) {
    if (answered.has(q.id)) continue;
    answered.add(q.id);
    await sleep(4000);
    if (q.seq % 4 === 0) {
      const { data: pid } = await me.rpc("submit_message", { p_conversation: conv, p_client_send_id: `qa-ans-${q.id}`, p_body: "In my own words: it's the people who depend on me.", p_kind: "answer", p_question: q.id });
      log(`Q${q.seq} custom answer submitted (pending ${pid})`);
    } else {
      await me.rpc("answer_with_choice", { p_question: q.id, p_choice: q.seq % 3 });
      log(`Q${q.seq} answered: "${q.choices[q.seq % 3]}"`);
    }
  }
  if (c.status === "chatting" && sentChat < 3) {
    const { data: msgs } = await me.from("approved_messages").select("sender_participant_id, body").eq("conversation_id", conv).order("created_at", { ascending: false }).limit(1);
    const { data: mine } = await me.rpc("my_participant_id", { p_conversation: conv });
    if (sentChat === 0 || (msgs?.[0] && msgs[0].sender_participant_id !== mine)) {
      const bodies = ["Thanks for doing this. Honestly I was nervous about it.", "That's fair. Where I live most people would say the same thing.", "I think we worry about the same things, just from different directions."];
      await me.rpc("submit_message", { p_conversation: conv, p_client_send_id: `qa-chat-${sentChat}`, p_body: bodies[sentChat] });
      log("sent chat:", bodies[sentChat]);
      sentChat++;
      await sleep(8000);
    }
  }
  await sleep(2500);
}
// after the end: say yes to reconnecting, then leave a reflection
await me.rpc("set_connection_decision", { p_conversation: conv, p_decision: true }).then(({ data }) => log("connection decision ->", data?.status));
log("done; partner account", email, "left in place for inspection");
