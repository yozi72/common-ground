"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { TwoCups, Bridge, Lantern } from "@/components/Illustrations";
import { ReminderControls, type ReminderPrefs } from "@/components/ReminderControls";
import { useServerClock } from "@/components/useServerClock";
import { deviceTimeZone } from "@/lib/push-client";
import { sessionState, formatSessionTime, formatCountdown, type ScheduleConfig, type SessionState } from "@/lib/schedule";

type Request = { id: string; status: string; expires_at: string; notify_email: boolean; created_at: string; paused_reason: string | null; broaden: "strict" | "relaxed" | "any"; session_start: string | null } | null;
type Invitation = { id: string; kind: string; expires_at: string; my_decision: string | null };

// Mirrors broaden_relaxed_after_seconds / broaden_any_after_seconds (server enforces).
const RELAXED_AFTER_MS = 60_000;
const ANY_AFTER_MS = 120_000;

export function Lobby(props: {
  userId: string; initialRequest: Request; initialInvitations: Invitation[]; emailAvailable: boolean; pushAvailable: boolean; vapidKey: string | null;
  schedule: ScheduleConfig; initialSession: SessionState; serverNow: number; timezoneOverride: string | null; reminderPrefs: ReminderPrefs | null; answeredCount?: number;
  undecided?: { conversation_id: string; peer_alias: string }[];
}) {
  const router = useRouter();
  const { now, sync, tick } = useServerClock(props.serverNow);
  const [request, setRequest] = useState<Request>(props.initialRequest);
  const [invitations, setInvitations] = useState<Invitation[]>(props.initialInvitations);
  const [session, setSession] = useState<SessionState>(props.initialSession);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tz, setTz] = useState<{ zone: string; source: "override" | "device" | "fallback" }>({ zone: props.timezoneOverride ?? props.schedule.timezone, source: props.timezoneOverride ? "override" : "fallback" });
  const prevStatus = useRef<string | null>(props.initialRequest?.status ?? null);
  const inQueue = !!request && ["waiting", "invited"].includes(request.status);

  // Device timezone (no location access): detected after mount and re-checked on focus unless overridden.
  useEffect(() => {
    const detect = () => {
      if (props.timezoneOverride) return;
      const d = deviceTimeZone();
      setTz(d ? { zone: d, source: "device" } : { zone: props.schedule.timezone, source: "fallback" });
    };
    const t = setTimeout(detect, 0);
    window.addEventListener("focus", detect);
    return () => { clearTimeout(t); window.removeEventListener("focus", detect); };
  }, [props.timezoneOverride, props.schedule.timezone]);

  // Session state is recomputed from the synced clock on every tick (pure, cheap).
  useEffect(() => { const t = setTimeout(() => setSession(sessionState(now(), props.schedule)), 0); return () => clearTimeout(t); }, [tick, now, props.schedule]);

  const refresh = useCallback(async () => {
    const sb = supabaseBrowser();
    const res = inQueue
      ? await fetch("/api/lobby", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "heartbeat" }) })
      : await fetch("/api/lobby");
    if (res.ok) { const j = await res.json(); sync(j.now); setSession(j.session); }
    const [{ data: req }, { data: inv }] = await Promise.all([
      sb.from("availability_requests").select("id, status, expires_at, notify_email, created_at, paused_reason, broaden, session_start").in("status", ["waiting", "invited"]).maybeSingle(),
      sb.from("invitation_participants").select("invitation_id, decision, match_invitations!inner(id, kind, status, expires_at, conversation_id)")
        .eq("account_id", props.userId).eq("match_invitations.status", "pending"),
    ]);
    const r = (req as Request) ?? null;
    if (prevStatus.current === "invited" && r?.status === "waiting" && !r.paused_reason) setNotice("The other person didn't respond in time. You're back in line with your original place.");
    prevStatus.current = r?.status ?? null;
    setRequest(r);
    type Inv = { invitation_id: string; decision: string | null; match_invitations: { kind: string; expires_at: string } };
    setInvitations(((inv ?? []) as unknown as Inv[]).map((i) => ({ id: i.invitation_id, kind: i.match_invitations.kind, expires_at: i.match_invitations.expires_at, my_decision: i.decision })));
    const { data: live } = await sb.from("participants").select("conversation_id, conversations!participants_conversation_id_fkey!inner(status, kind)").eq("account_id", props.userId).is("left_at", null).neq("conversations.status", "ended").eq("conversations.kind", "live").limit(1);
    if (live?.length) router.push(`/c/${live[0].conversation_id}`);
  }, [props.userId, router, inQueue, sync]);

  useEffect(() => {
    const sb = supabaseBrowser();
    const ch = sb.channel(`lobby:${props.userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `account_id=eq.${props.userId}` }, () => refresh())
      .subscribe();
    const poll = setInterval(refresh, inQueue ? 5000 : 15000);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { sb.removeChannel(ch); clearInterval(poll); document.removeEventListener("visibilitychange", onVisible); };
  }, [props.userId, refresh, inQueue]);

  async function call(body: unknown, url = "/api/lobby") {
    setBusy(true); setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(json.error ?? "Something went wrong"); return null; }
    if (json.now) sync(json.now);
    return json;
  }
  const join = async () => { if (await call({ action: "join", notify_email: false }, "/api/queue")) { setNotice(null); await refresh(); } };
  const leave = async () => { if (await call({ action: "leave" }, "/api/queue")) await refresh(); };
  const ready = async () => { if (await call({ action: "ready" })) { setNotice(null); await refresh(); } };
  const broaden = async (level: "strict" | "relaxed" | "any") => { if (await call({ action: "broaden", level })) await refresh(); };
  const respond = async (id: string, accept: boolean) => {
    const r = await call({ accept }, `/api/invitations/${id}`);
    if (!r) return;
    if (r.status === "opened") router.push(`/c/${r.conversation_id}`); else await refresh();
  };

  const t = now();
  const secondsLeft = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - t) / 1000));
  const waitedMs = request ? Math.max(0, t - new Date(request.created_at).getTime()) : 0;
  const tzLabel = tz.source === "fallback" ? "Pacific time" : tz.zone.replace(/_/g, " ");
  const next = session.phase === "before" ? session.next : session.phase === "open" ? session.next : null;
  const fmt = (s: { start: number; end: number; dateKey: string }) => formatSessionTime(s, tz.zone, props.schedule.timezone);
  const scheduleLabel = props.schedule.timezone === "America/Los_Angeles" ? `${to12h(props.schedule.startTime)} Pacific` : `${props.schedule.startTime} ${props.schedule.timezone}`;

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h1 className="text-3xl font-semibold">Talk</h1>
        <span className="muted text-xs">Times in {tzLabel}{tz.source === "fallback" ? " (couldn't detect your timezone)" : ""} · <Link className="underline" href="/settings#timezone">change</Link></span>
      </div>
      {error && <div className="notice notice-bad" role="alert">{error}</div>}
      {notice && <div className="notice notice-warn" role="status">{notice}</div>}
      {(props.undecided ?? []).slice(0, 2).map((u) => (
        <div key={u.conversation_id} className="notice text-sm flex items-center justify-between gap-3 flex-wrap" role="status">
          <span>You haven&apos;t said yet whether you&apos;d keep talking with {u.peer_alias}.</span>
          <Link className="btn btn-secondary text-sm" href={`/c/${u.conversation_id}/reflect`}>Decide</Link>
        </div>
      ))}

      {invitations.map((inv) => (
        <section key={inv.id} className="card space-y-3 pop" aria-live="polite" style={{ borderColor: "var(--accent)" }}>
          <Bridge className="w-32 h-auto mx-auto" />
          <h2 className="font-semibold text-xl text-center">We found someone</h2>
          <p className="muted text-sm text-center">They answered some questions differently from you. That's all either of you will know. The conversation opens once you both accept.</p>
          <Countdown label="Time left to accept" seconds={secondsLeft(inv.expires_at)} urgent />
          {inv.my_decision === "accepted" ? (
            <p className="notice notice-ok text-center">You accepted. Waiting for the other person…</p>
          ) : (
            <div className="flex gap-2">
              <button className="btn btn-primary flex-1" disabled={busy} onClick={() => respond(inv.id, true)}>Accept</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => respond(inv.id, false)}>Not now</button>
            </div>
          )}
        </section>
      ))}

      {request?.status === "waiting" && request.paused_reason === "no_response" && (
        <section className="card space-y-3" aria-live="polite">
          <h2 className="font-semibold text-xl">You missed an invitation</h2>
          <p className="muted text-sm">We paused your spot so nobody else waits on you. When you&apos;re here and ready, say so and we&apos;ll keep looking. Your place in line is kept.</p>
          <div className="flex gap-2">
            <button className="btn btn-primary flex-1" disabled={busy} onClick={ready}>I&apos;m ready</button>
            <button className="btn btn-secondary" disabled={busy} onClick={leave}>Leave</button>
          </div>
        </section>
      )}

      {request?.status === "waiting" && request.paused_reason !== "no_response" && invitations.length === 0 && (
        <section className="card space-y-3" aria-live="polite">
          <TwoCups className="w-32 h-auto mx-auto float" />
          <h2 className="font-semibold text-xl text-center">Looking for someone ready to talk</h2>
          <div className="grid grid-cols-2 gap-2 text-center">
            <Stat label="You've waited" value={formatCountdown(waitedMs)} />
            <Stat label="New matches close in" value={session.phase === "open" ? formatCountdown(session.msUntilEnd) : "closed"} />
          </div>
          <p className="muted text-xs text-center">Keep this page open: we only pair people who are here right now.</p>
          {(props.answeredCount ?? 8) < 5 && request.broaden !== "any" && (
            <div className="notice notice-warn space-y-2">
              <p>You&apos;ve answered {props.answeredCount ?? 0} of 8 matching questions. With fewer than 5 we can&apos;t tell who differs from you, so matching only works with &ldquo;anyone available&rdquo;. You can add answers in <Link className="underline" href="/onboarding">Profile</Link>.</p>
              <button className="btn btn-secondary" disabled={busy} onClick={() => broaden("any")}>Match me with anyone available</button>
            </div>
          )}
          {waitedMs >= RELAXED_AFTER_MS && request.broaden === "strict" && (
            <div className="notice notice-warn space-y-2">
              <p>Still looking. Would you accept someone whose answers differ from yours a little less?</p>
              <button className="btn btn-secondary" disabled={busy} onClick={() => broaden("relaxed")}>Yes, allow a smaller difference</button>
            </div>
          )}
          {waitedMs >= ANY_AFTER_MS && request.broaden !== "any" && (
            <div className="notice notice-warn space-y-2">
              <p>Match me with anyone who&apos;s available, regardless of how we answered?</p>
              <button className="btn btn-secondary" disabled={busy} onClick={() => broaden("any")}>Yes, anyone available</button>
            </div>
          )}
          {request.broaden !== "strict" && (
            <p className="text-xs text-center muted">
              Matching: {request.broaden === "any" ? "anyone available" : "smaller difference allowed"} · <button className="underline" disabled={busy} onClick={() => broaden("strict")}>back to different views only</button>
            </p>
          )}
          <button className="btn btn-secondary w-full" disabled={busy} onClick={leave}>Leave the list</button>
        </section>
      )}

      {!request && invitations.length === 0 && session.phase === "open" && (
        <section className="card space-y-4">
          <TwoCups className="w-32 h-auto mx-auto" />
          <h2 className="font-semibold text-xl text-center">The session is open</h2>
          <Countdown label="New matches close in" seconds={Math.floor(session.msUntilEnd / 1000)} />
          <p className="muted text-sm text-center">You&apos;ll be paired with another adult who&apos;s here right now and answered differently from you. Join at the start for the best chance of a match.</p>
          <button className="btn btn-primary w-full" disabled={busy} onClick={join}>{busy ? "Joining…" : "Talk now"}</button>
        </section>
      )}

      {!request && invitations.length === 0 && session.phase === "before" && (
        <section className="card space-y-4">
          <Lantern className="w-28 h-auto mx-auto float" />
          <div className="text-center">
            <p className="eyebrow">Next session</p>
            <h2 className="font-semibold text-2xl">{fmt(session.next).date} · {fmt(session.next).range}</h2>
            <p className="muted text-sm">{fmt(session.next).tzName}{fmt(session.next).startsOnDifferentDate ? " · a different calendar date where you are" : ""} · one shared hour for everyone ({scheduleLabel})</p>
          </div>
          <Countdown label="Starts in" seconds={Math.floor(session.msUntilStart / 1000)} />
          <p className="muted text-sm text-center">Join at the start for the best chance of a match. Matching only runs during the hour, so there&apos;s nothing to wait in now.</p>
          <details className="card-flat" open={!props.reminderPrefs}>
            <summary className="cursor-pointer font-semibold">Remind me</summary>
            <div className="mt-3">
              <ReminderControls initial={props.reminderPrefs} schedule={props.schedule} pushAvailable={props.pushAvailable} emailAvailable={props.emailAvailable} vapidKey={props.vapidKey} nextSessionStartIso={next ? new Date(next.start).toISOString() : null} compact />
            </div>
          </details>
        </section>
      )}

      {!request && invitations.length === 0 && session.phase === "none" && (
        <section className="card"><p className="muted">No sessions are scheduled right now.</p></section>
      )}
    </div>
  );
}

function to12h(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${String(m).padStart(2, "0")} ${ampm}` : `${hh} ${ampm}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl py-2" style={{ background: "var(--bg-2)" }}>
      <div className="text-xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-display)" }} aria-hidden="true">{value}</div>
      <div className="muted text-xs">{label}</div>
      <span className="sr-only">{label}: {value}</span>
    </div>
  );
}

// Ticking digits are hidden from screen readers; a polite summary changes at most once a minute.
function Countdown({ label, seconds, urgent = false }: { label: string; seconds: number; urgent?: boolean }) {
  const minutes = Math.ceil(seconds / 60);
  return (
    <div className="text-center">
      <p className="muted text-xs">{label}</p>
      <p className="text-2xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-display)", color: urgent && seconds <= 15 ? "var(--bad-fg)" : "var(--fg)" }} aria-hidden="true">{formatCountdown(seconds * 1000)}</p>
      <p className="sr-only" aria-live="polite">{label}: {seconds < 60 ? "less than a minute" : `about ${minutes} minutes`}</p>
    </div>
  );
}
