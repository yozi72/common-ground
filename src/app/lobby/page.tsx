import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Lobby } from "./Lobby";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function LobbyPage() {
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const { data: account } = await supabase.from("accounts").select("onboarding_complete, role").eq("id", auth.user.id).maybeSingle();
  if (!account?.onboarding_complete) {
    if (account?.role !== "admin") redirect("/onboarding");
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Talk</h1>
        <section className="card space-y-3">
          <h2 className="font-medium">You're signed in as a reviewer</h2>
          <p className="muted text-sm">Reviewer accounts don't take part in conversations unless you choose to. If you'd like to try the participant side yourself, set up a participant profile; it takes about two minutes.</p>
          <div className="flex gap-2 flex-wrap">
            <a className="btn btn-primary" href="/onboarding">Set up to take part</a>
            <a className="btn btn-secondary" href="/admin">Go to Review</a>
          </div>
        </section>
      </div>
    );
  }

  // An open conversation takes priority over the queue.
  const { data: live } = await supabase
    .from("participants").select("conversation_id, conversations!participants_conversation_id_fkey!inner(status)")
    .eq("account_id", auth.user.id).is("left_at", null).neq("conversations.status", "ended").limit(1);
  if (live?.length) redirect(`/c/${live[0].conversation_id}`);

  const [{ data: request }, { data: invitations }] = await Promise.all([
    supabase.from("availability_requests").select("id, status, expires_at, notify_email").in("status", ["waiting", "invited"]).maybeSingle(),
    supabase.from("invitation_participants").select("invitation_id, decision, match_invitations!inner(id, kind, status, expires_at, conversation_id)")
      .eq("account_id", auth.user.id).eq("match_invitations.status", "pending"),
  ]);

  type Inv = { invitation_id: string; decision: string | null; match_invitations: { id: string; kind: string; status: string; expires_at: string; conversation_id: string | null } };
  const invs = ((invitations ?? []) as unknown as Inv[]).map((i) => ({ id: i.invitation_id, kind: i.match_invitations.kind, expires_at: i.match_invitations.expires_at, my_decision: i.decision }));

  return <Lobby userId={auth.user.id} initialRequest={request ?? null} initialInvitations={invs} emailAvailable={env.emailConfigured()} />;
}
