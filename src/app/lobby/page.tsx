import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Lobby } from "./Lobby";
import { env } from "@/lib/env";
import { getScheduleConfig, serverNow } from "@/lib/schedule-config";
import { sessionState } from "@/lib/schedule";

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
        <h1 className="text-3xl font-semibold">Talk</h1>
        <section className="card space-y-3">
          <h2 className="font-semibold">You&apos;re signed in as a reviewer</h2>
          <p className="muted text-sm">Reviewer accounts don&apos;t take part in conversations unless you choose to. If you&apos;d like to try the participant side yourself, set up a participant profile; it takes about two minutes.</p>
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

  const [{ data: request }, { data: invitations }, { data: profile }, { data: prefs }, schedule] = await Promise.all([
    supabase.from("availability_requests").select("id, status, expires_at, notify_email, created_at, paused_reason, broaden, session_start").in("status", ["waiting", "invited"]).maybeSingle(),
    supabase.from("invitation_participants").select("invitation_id, decision, match_invitations!inner(id, kind, status, expires_at, conversation_id)")
      .eq("account_id", auth.user.id).eq("match_invitations.status", "pending"),
    supabase.from("profiles").select("timezone_override, political_answers").eq("account_id", auth.user.id).maybeSingle(),
    supabase.from("reminder_prefs").select("push_enabled, email_enabled, mode, days, minutes_before, next_session_start").eq("account_id", auth.user.id).maybeSingle(),
    getScheduleConfig(),
  ]);

  type Inv = { invitation_id: string; decision: string | null; match_invitations: { id: string; kind: string; status: string; expires_at: string; conversation_id: string | null } };
  const invs = ((invitations ?? []) as unknown as Inv[]).map((i) => ({ id: i.invitation_id, kind: i.match_invitations.kind, expires_at: i.match_invitations.expires_at, my_decision: i.decision }));
  const now = serverNow();

  return (
    <Lobby
      userId={auth.user.id}
      initialRequest={request ?? null}
      initialInvitations={invs}
      emailAvailable={env.emailConfigured()}
      pushAvailable={env.pushConfigured()}
      vapidKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null}
      schedule={schedule}
      initialSession={sessionState(now, schedule)}
      serverNow={now}
      timezoneOverride={profile?.timezone_override ?? null}
      reminderPrefs={(prefs as never) ?? null}
      answeredCount={Object.keys((profile?.political_answers as Record<string, unknown>) ?? {}).length}
    />
  );
}
