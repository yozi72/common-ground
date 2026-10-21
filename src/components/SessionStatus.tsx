"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useServerClock } from "@/components/useServerClock";
import { deviceTimeZone } from "@/lib/push-client";
import { sessionState, formatSessionTime, type ScheduleConfig, type SessionState } from "@/lib/schedule";

// Homepage: when new-person matching is available, in the visitor's own
// timezone, from the same schedule configuration every other screen uses.
// Recomputed every second from the server-synced clock (so the label flips
// exactly when the window opens or closes) and when the tab regains focus.
export function SessionStatus({ schedule, serverNow, initialSession, href }: { schedule: ScheduleConfig; serverNow: number; initialSession: SessionState; href: string }) {
  const { now, tick } = useServerClock(serverNow);
  const [session, setSession] = useState<SessionState>(initialSession);
  const [tz, setTz] = useState<{ zone: string; source: "device" | "fallback" }>({ zone: schedule.timezone, source: "fallback" });

  useEffect(() => {
    const detect = () => { const d = deviceTimeZone(); setTz(d ? { zone: d, source: "device" } : { zone: schedule.timezone, source: "fallback" }); };
    const t = setTimeout(detect, 0);
    window.addEventListener("focus", detect);
    return () => { clearTimeout(t); window.removeEventListener("focus", detect); };
  }, [schedule.timezone]);
  useEffect(() => { const t = setTimeout(() => setSession(sessionState(now(), schedule)), 0); return () => clearTimeout(t); }, [tick, now, schedule]);

  const fmt = (s: { start: number; end: number; dateKey: string }) => formatSessionTime(s, tz.zone, schedule.timezone);
  const tzLabel = tz.source === "fallback" ? "Pacific time (we couldn't detect your timezone)" : tz.zone.replace(/_/g, " ");
  const open = session.phase === "open";
  const next = session.phase === "open" ? session.next : session.phase === "before" ? session.next : null;
  const daily = schedule.days.length === 7;
  const dayNames = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  const whenLabel = daily ? "Every day" : schedule.days.map((d) => dayNames[d]).join(", ");

  return (
    <div className="space-y-3">
      <div className="flex gap-3 justify-center flex-wrap pt-1">
        <Link href={href} className="btn btn-primary">{open ? "Find someone to talk to" : "Get ready for the next session"}</Link>
        <a href="#how" className="btn btn-secondary">How it works</a>
      </div>
      <div className="card-flat text-sm text-center space-y-1" style={{ background: "var(--bg-2)" }} aria-live="polite">
        {open && session.phase === "open" ? (
          <p className="font-semibold">Matching is open right now, until {new Intl.DateTimeFormat("en-US", { timeZone: tz.zone, hour: "numeric", minute: "2-digit" }).format(new Date(session.current.end))}.</p>
        ) : next ? (
          <p className="font-semibold">Next session: {fmt(next).date} · {fmt(next).range} {fmt(next).tzName}{fmt(next).startsOnDifferentDate ? " (a different calendar date where you are)" : ""}</p>
        ) : (
          <p className="font-semibold">No sessions are scheduled right now.</p>
        )}
        <p className="muted">
          New-person matching happens {whenLabel.toLowerCase()} for {schedule.durationMinutes} minutes, starting {to12h(schedule.startTime)} {schedule.timezone === "America/Los_Angeles" ? "Pacific" : schedule.timezone}. Times shown in {tzLabel}.
        </p>
        <p className="muted">You can sign up, answer the questionnaire and set a reminder any time. Once you become friends, you can message each other anytime.</p>
      </div>
    </div>
  );
}

function to12h(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${String(m).padStart(2, "0")} ${ampm}` : `${hh} ${ampm}`;
}
