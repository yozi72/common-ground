import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DeleteAccount } from "./DeleteAccount";
import { badgesFor, nextMilestone, type Stats } from "@/lib/badges";
import { Lantern } from "@/components/Illustrations";
import { ReminderControls } from "@/components/ReminderControls";
import { TimezoneSetting } from "./TimezoneSetting";
import { env } from "@/lib/env";
import { getScheduleConfig, serverNow } from "@/lib/schedule-config";
import { nextSessions } from "@/lib/schedule";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const [{ data: profile }, { data: statsRows }, { data: prefs }, schedule] = await Promise.all([
    supabase.from("profiles").select("age_band, region, community, life_context, share_context_with_prompts, political_answers, timezone_override").eq("account_id", auth.user.id).maybeSingle(),
    supabase.rpc("my_stats"),
    supabase.from("reminder_prefs").select("push_enabled, email_enabled, mode, days, minutes_before, next_session_start").eq("account_id", auth.user.id).maybeSingle(),
    getScheduleConfig(),
  ]);
  const upcoming = nextSessions(serverNow(), 1, schedule)[0] ?? null;
  const answered = profile ? Object.keys(profile.political_answers ?? {}).length : 0;
  const stats: Stats = (Array.isArray(statsRows) ? statsRows[0] : statsRows) ?? { people: 0, conversations: 0, friends: 0, full_rounds: 0, reconnections: 0 };
  const badges = badgesFor(stats);
  const earned = badges.filter((b) => b.earned);
  const milestone = nextMilestone(stats);

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold">Profile</h1>

      <section className="card space-y-4" aria-labelledby="stats-title">
        <h2 id="stats-title" className="sr-only">Your participation</h2>
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat n={stats.people} label={stats.people === 1 ? "person" : "people"} sub="talked with" />
          <Stat n={stats.conversations} label={stats.conversations === 1 ? "conversation" : "conversations"} sub="completed" />
          <Stat n={stats.friends} label={stats.friends === 1 ? "friend" : "friends"} sub="mutual" />
        </div>
        {milestone && <p className="text-center text-sm muted">{milestone}</p>}
      </section>

      <section className="space-y-3" aria-labelledby="badges-title">
        <div className="flex items-baseline justify-between">
          <h2 id="badges-title" className="font-semibold text-xl">Badges</h2>
          <span className="muted text-sm">{earned.length} of {badges.length}</span>
        </div>
        <ul className="grid grid-cols-4 sm:grid-cols-5 gap-2">
          {badges.map((b) => (
            <li key={b.id} className="flex flex-col items-center text-center gap-0.5 rounded-2xl p-2" style={{ opacity: b.earned ? 1 : 0.5, background: b.earned ? "var(--card)" : "transparent", border: b.earned ? "1px solid var(--line)" : "1px dashed var(--line)" }}
              title={b.description} aria-label={`${b.name}: ${b.description}${b.earned ? ", earned" : b.progress ? `, ${b.progress}` : ", not yet"}`}>
              <BadgeIcon kind={b.kind} earned={b.earned} />
              <p className="font-semibold text-[11px] leading-tight">{b.name}</p>
              {!b.earned && b.progress && <p className="text-[10px]" style={{ color: "var(--accent)" }}>{b.progress}</p>}
            </li>
          ))}
        </ul>
        <p className="muted text-xs">Badges are about taking part. The person you talk with only ever sees a rough tier, never your exact numbers.</p>
      </section>

      <section id="reminders" className="card space-y-3">
        <h2 className="font-semibold text-xl">Reminders</h2>
        <p className="muted text-sm">The conversation hour is the same shared hour for everyone, every session day. Reminders are optional and you can turn them off here any time.</p>
        <ReminderControls initial={(prefs as never) ?? null} schedule={schedule} pushAvailable={env.pushConfigured()} emailAvailable={env.emailConfigured()} vapidKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null} nextSessionStartIso={upcoming ? new Date(upcoming.start).toISOString() : null} />
      </section>

      <TimezoneSetting override={profile?.timezone_override ?? null} />

      <section className="card space-y-2 text-sm">
        <h2 className="font-semibold">About you</h2>
        <p className="muted">Age {profile?.age_band ?? "—"} · {profile?.region ?? "—"} · {profile?.community ?? "—"} · {profile?.life_context?.length ? profile.life_context.join(", ") : "no life context"}</p>
        <p className="muted">Matching questionnaire: {answered} of 5 answered. Context sharing for questions: {profile?.share_context_with_prompts ? "on" : "off"}.</p>
        <a className="btn btn-secondary" href="/onboarding">Edit</a>
      </section>

      <section className="card space-y-2 text-sm">
        <h2 className="font-semibold">Your account</h2>
        <p className="muted">Signed in as {auth.user.email}. This is never shown to other participants.</p>
        <form action="/auth/signout" method="post"><button className="btn btn-secondary">Sign out</button></form>
      </section>

      <DeleteAccount />
      <Lantern className="w-24 h-auto mx-auto opacity-60" />
    </div>
  );
}

function Stat({ n, label, sub }: { n: number; label: string; sub: string }) {
  return (
    <div className="rounded-2xl py-2" style={{ background: "var(--bg-2)" }}>
      <div className="text-2xl font-semibold" style={{ fontFamily: "var(--font-display)" }}>{n}</div>
      <div className="text-sm font-semibold">{label}</div>
      <div className="muted text-xs">{sub}</div>
    </div>
  );
}

function BadgeIcon({ kind, earned }: { kind: "people" | "friends" | "special"; earned: boolean }) {
  const fill = earned ? (kind === "people" ? "var(--accent-2)" : kind === "friends" ? "var(--sage-2)" : "var(--sun-2)") : "var(--bg-2)";
  const stroke = earned ? (kind === "people" ? "var(--accent)" : kind === "friends" ? "var(--sage)" : "var(--sun)") : "var(--line)";
  return (
    <svg width="38" height="38" viewBox="0 0 56 56" aria-hidden="true">
      <path d="M28 4l6.5 4.5 7.8-.6 2.9 7.3 6.8 3.9-1.7 7.7 3.6 7-5.8 5.3-.5 7.9-7.7 1.5L28 52l-7.9-3.5-7.7-1.5-.5-7.9-5.8-5.3 3.6-7-1.7-7.7 6.8-3.9 2.9-7.3 7.8.6z" fill={fill} stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" />
      {kind === "people" && <path d="M19 33c0-5 4-8 9-8s9 3 9 8M28 23a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" />}
      {kind === "friends" && <path d="M28 36s-9-5.5-9-12a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6.5-9 12-9 12z" fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" />}
      {kind === "special" && <path d="M28 17l3.2 6.6 7.3 1-5.3 5.1 1.3 7.3L28 33.6 21.5 37l1.3-7.3-5.3-5.1 7.3-1z" fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" />}
    </svg>
  );
}
