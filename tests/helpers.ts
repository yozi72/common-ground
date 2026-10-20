// Test harness against a running Supabase (local `npx supabase start` or a
// hosted test project). Creates real auth users and talks to the database the
// same way the app does: user JWTs for RPCs/RLS, service role for workers.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
export const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
export const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const admin = () => createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

export type TestUser = { id: string; email: string; client: SupabaseClient };

export async function makeUser(tag: string, answers: Record<string, number>, onboard = true): Promise<TestUser> {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const password = "test-password-" + Math.random().toString(36).slice(2);
  const a = admin();
  const { data, error } = await a.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  if (onboard) {
    const { error: e3 } = await client.rpc("complete_onboarding", {
      p_age_band: "25-34", p_region: "midwest", p_community: "suburban", p_life_context: ["parent"],
      p_share_context: false, p_political_answers: answers, p_terms_version: "test",
    });
    if (e3) throw e3;
  }
  return { id: data.user.id, email, client };
}

export async function deleteUser(u: TestUser) {
  await admin().auth.admin.deleteUser(u.id);
}

export const LEFT = { gov_role: -2, tradition: -2, immigration: -2, economy: -2, institutions: -2 };
export const RIGHT = { gov_role: 2, tradition: 2, immigration: 2, economy: 2, institutions: 2 };
export const MIXED = { gov_role: 0, tradition: 1, immigration: -1 };

// Tests share one database; clear live queue state so an earlier test's
// waiter is not paired by a later test (oldest-first matching is by design).
export async function resetQueue() {
  const a = admin();
  await a.from("availability_requests").update({ status: "cancelled", ended_at: new Date().toISOString() }).in("status", ["waiting", "invited"]);
  await a.from("match_invitations").update({ status: "expired", resolved_at: new Date().toISOString() }).eq("status", "pending");
}

export async function matchPair(a: TestUser, b: TestUser) {
  const { error: ea } = await a.client.rpc("join_queue", { p_notify_email: false });
  if (ea) throw ea;
  const { error: eb } = await b.client.rpc("join_queue", { p_notify_email: false });
  if (eb) throw eb;
  const { data: pairs, error } = await admin().rpc("run_matching");
  if (error) throw error;
  const { data: inv } = await a.client.from("invitation_participants").select("invitation_id").eq("account_id", a.id).limit(1).single();
  return { pairs: pairs as number, invitationId: inv!.invitation_id as string };
}

export async function openConversation(a: TestUser, b: TestUser) {
  const { invitationId } = await matchPair(a, b);
  const [ra, rb] = await Promise.all([
    a.client.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true }),
    b.client.rpc("respond_invitation", { p_invitation: invitationId, p_accept: true }),
  ]);
  if (ra.error) throw ra.error;
  if (rb.error) throw rb.error;
  const conv = (ra.data.conversation_id ?? rb.data.conversation_id) as string;
  return conv;
}

export async function answerAll(u: TestUser, conversationId: string, questionId: string) {
  const { error } = await u.client.rpc("answer_with_choice", { p_question: questionId, p_choice: 0 });
  if (error) throw error;
  void conversationId;
}

// Drive the opening round to completion so chat opens. Uses the mock question bank.
export async function finishOpeningRound(a: TestUser, b: TestUser, conversationId: string, generate: (id: string, phase: "opening" | "mid") => Promise<string | null>) {
  for (let i = 0; i < 10; i++) {
    const qid = await generate(conversationId, "opening");
    if (!qid) break;
    await answerAll(a, conversationId, qid);
    await answerAll(b, conversationId, qid);
  }
  const { data } = await admin().from("conversations").select("status").eq("id", conversationId).single();
  return data!.status as string;
}
