"use client";
import { useEffect, useState } from "react";
import { enablePush, disablePush, currentSubscription, pushSupport, type PushSupport } from "@/lib/push-client";
import type { ScheduleConfig } from "@/lib/schedule";

export type ReminderPrefs = { push_enabled: boolean; email_enabled: boolean; mode: "next" | "weekdays" | "daily"; days: number[]; minutes_before: number; next_session_start: string | null };
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ReminderControls({ initial, schedule, pushAvailable, emailAvailable, vapidKey, nextSessionStartIso, compact = false }: {
  initial: ReminderPrefs | null; schedule: ScheduleConfig; pushAvailable: boolean; emailAvailable: boolean; vapidKey: string | null; nextSessionStartIso: string | null; compact?: boolean;
}) {
  const [prefs, setPrefs] = useState<ReminderPrefs>(initial ?? { push_enabled: false, email_enabled: false, mode: "daily", days: schedule.days, minutes_before: 10, next_session_start: null });
  const [support, setSupport] = useState<PushSupport>({ supported: false, needsInstall: false });
  const [thisDevice, setThisDevice] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setSupport(pushSupport());
      currentSubscription().then((s) => setThisDevice(!!s)).catch(() => setThisDevice(false));
    }, 0);
    return () => clearTimeout(t);
  }, []);

  async function save(patch: Partial<ReminderPrefs>) {
    setBusy(true); setMsg(null);
    const next = { ...prefs, ...patch };
    const body = { action: "prefs", ...patch, ...(patch.mode === "next" || (next.mode === "next" && patch.mode === undefined) ? { next_session_start: nextSessionStartIso } : {}) };
    const res = await fetch("/api/reminders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) { setMsg((await res.json().catch(() => ({}))).error ?? "Couldn't save"); return; }
    setPrefs(next);
  }

  async function onEnablePush() {
    if (!vapidKey) return;
    setBusy(true); setMsg(null);
    try {
      const r = await enablePush(vapidKey);
      if (r === "granted") { setThisDevice(true); await save({ push_enabled: true }); setMsg("Notifications are on for this device."); }
      else if (r === "denied") setMsg("Notifications are blocked for this site in your browser settings. You can use a calendar reminder or email instead.");
      else setMsg(support.reason ?? "Notifications aren't available here. Try a calendar reminder or email.");
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }
  async function onDisablePush() {
    setBusy(true);
    await disablePush();
    setThisDevice(false);
    await save({ push_enabled: false });
    setMsg("Notifications are off for this device.");
    setBusy(false);
  }

  const calendarQuery = `mode=${prefs.mode}&days=${prefs.days.join(",")}`;

  return (
    <div className="space-y-4">
      {/* Which sessions */}
      <fieldset>
        <legend className="eyebrow mb-2">Remind me about</legend>
        <div className="flex flex-wrap gap-2">
          {([["next", "Next session only"], ["weekdays", "Selected days"], ["daily", "Every session"]] as const).map(([m, label]) => (
            <button key={m} type="button" className="chip" aria-pressed={prefs.mode === m} disabled={busy} onClick={() => save({ mode: m })}>{label}</button>
          ))}
        </div>
        {prefs.mode === "weekdays" && (
          <div className="flex flex-wrap gap-1 mt-2" role="group" aria-label="Days">
            {DAY_LABELS.map((d, i) => (
              <button key={d} type="button" className="chip px-3" aria-pressed={prefs.days.includes(i)} disabled={busy || !schedule.days.includes(i)}
                onClick={() => save({ days: prefs.days.includes(i) ? prefs.days.filter((x) => x !== i) : [...prefs.days, i].sort() })}>{d}</button>
            ))}
          </div>
        )}
        <p className="muted text-xs mt-2">Reminders go out {prefs.minutes_before} minutes before the session starts.</p>
      </fieldset>

      {/* Calendar */}
      <div className="space-y-2">
        <p className="eyebrow">Add to calendar</p>
        <div className="flex flex-wrap gap-2">
          <a className="btn btn-secondary" href={`/api/calendar?${calendarQuery}`} download>Apple / Outlook (.ics)</a>
          <a className="btn btn-secondary" href={`/api/calendar?${calendarQuery}&google=1`} target="_blank" rel="noopener">Google Calendar</a>
        </div>
        {!compact && (
          <p className="muted text-xs">The event asks for an alert 10 minutes before; your calendar app decides the final alert settings. Imported events are managed in your calendar app: changing a preference here doesn&apos;t remove one, and a downloaded event won&apos;t update by itself if the schedule changes.</p>
        )}
      </div>

      {/* Push */}
      <div className="space-y-2">
        <p className="eyebrow">Phone notifications</p>
        {!pushAvailable ? (
          <p className="muted text-sm">Not set up on this server yet. Use a calendar reminder{emailAvailable ? " or email" : ""} instead.</p>
        ) : support.needsInstall ? (
          <div className="notice notice-warn text-sm space-y-1">
            <p>{support.reason}</p>
            <p>In Safari: tap the Share button, then <strong>Add to Home Screen</strong>, open Common Ground from there, and come back to this page to turn notifications on.</p>
          </div>
        ) : !support.supported ? (
          <p className="muted text-sm">{support.reason ?? "This browser can't show notifications."} Use a calendar reminder{emailAvailable ? " or email" : ""} instead.</p>
        ) : thisDevice ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="badge">On for this device</span>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={onDisablePush}>Turn off on this device</button>
          </div>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onEnablePush}>Enable phone notifications</button>
        )}
        {!compact && <p className="muted text-xs">These are push notifications, not alarms: your phone&apos;s focus and notification settings decide whether they make a sound. Each device is enabled separately.</p>}
      </div>

      {/* Email */}
      {emailAvailable && (
        <label className="flex gap-3 items-start cursor-pointer">
          <input type="checkbox" className="mt-1 h-5 w-5 accent-[var(--accent)]" checked={prefs.email_enabled} disabled={busy} onChange={(e) => save({ email_enabled: e.target.checked })} />
          <span className="text-sm">Also email me before the session. (Fallback if notifications don&apos;t arrive.)</span>
        </label>
      )}

      {msg && <p className="notice notice-ok text-sm" role="status">{msg}</p>}
    </div>
  );
}
