"use client";
import { useEffect, useState } from "react";
import { enablePush, disablePush, currentSubscription, pushSupport, isIOSDevice, type PushSupport } from "@/lib/push-client";
import type { ScheduleConfig } from "@/lib/schedule";

export type ReminderPrefs = { push_enabled: boolean; email_enabled: boolean; mode: "next" | "weekdays" | "daily"; days: number[]; minutes_before: number; next_session_start: string | null };
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const IOS_HELP_KEY = "cg-ios-calendar-help-seen";

// App-managed reminders (email, phone) are a draft until "Save reminder
// preferences". Calendar export is separate and never reports success: only
// the calendar app knows whether the event was added.
export function ReminderControls({ initial, schedule, pushAvailable, emailAvailable, vapidKey, nextSessionStartIso, compact = false }: {
  initial: ReminderPrefs | null; schedule: ScheduleConfig; pushAvailable: boolean; emailAvailable: boolean; vapidKey: string | null; nextSessionStartIso: string | null; compact?: boolean;
}) {
  // First-time setup starts with email ON (if the server can send); an explicit saved opt-out stays off.
  const defaults: ReminderPrefs = { push_enabled: false, email_enabled: emailAvailable, mode: "daily", days: schedule.days, minutes_before: 10, next_session_start: null };
  const [saved, setSaved] = useState<ReminderPrefs | null>(initial);
  const [draft, setDraft] = useState<ReminderPrefs>(initial ?? defaults);
  const [support, setSupport] = useState<PushSupport>({ supported: false, needsInstall: false });
  const [isIOS, setIsIOS] = useState(false);
  const [thisDevice, setThisDevice] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "warn" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setSupport(pushSupport());
      setIsIOS(isIOSDevice());
      currentSubscription().then((s) => setThisDevice(!!s)).catch(() => setThisDevice(false));
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const dirty = !saved || JSON.stringify({ ...saved, next_session_start: null }) !== JSON.stringify({ ...draft, next_session_start: null });

  async function savePrefs() {
    setBusy(true); setMsg(null);
    const body = { action: "prefs", push_enabled: draft.push_enabled, email_enabled: draft.email_enabled, mode: draft.mode, days: draft.days, minutes_before: draft.minutes_before, next_session_start: draft.mode === "next" ? nextSessionStartIso : null };
    const res = await fetch("/api/reminders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) { setMsg({ kind: "bad", text: (await res.json().catch(() => ({}))).error ?? "Couldn't save" }); return; }
    const next = { ...draft, next_session_start: body.next_session_start };
    setSaved(next); setDraft(next);
    const on = [draft.email_enabled && "email", draft.push_enabled && "phone"].filter(Boolean) as string[];
    const when = draft.mode === "next" ? "for the next session" : draft.mode === "weekdays" ? "on your selected days" : "for every session";
    setMsg({ kind: "ok", text: on.length === 0 ? "Email and phone reminders are off." : `${on.map((s) => s[0].toUpperCase() + s.slice(1)).join(" and ")} reminders saved ${when}, 10 minutes before.` });
  }

  async function onEnablePush() {
    if (!vapidKey) return;
    setBusy(true); setMsg(null);
    try {
      const r = await enablePush(vapidKey);
      if (r === "granted") { setThisDevice(true); setDraft({ ...draft, push_enabled: true }); setMsg({ kind: "ok", text: "This device can receive notifications. Tap “Save reminder preferences” to turn them on." }); }
      else if (r === "denied") setMsg({ kind: "warn", text: "Notifications are blocked for this site in your browser settings. Email or a calendar reminder still work." });
      else setMsg({ kind: "warn", text: support.reason ?? "Notifications aren't available here." });
    } catch (e) { setMsg({ kind: "bad", text: (e as Error).message }); }
    setBusy(false);
  }
  async function onDisablePush() {
    setBusy(true);
    await disablePush();
    setThisDevice(false);
    setDraft({ ...draft, push_enabled: false });
    setMsg({ kind: "ok", text: "This device won't receive notifications. Save to confirm." });
    setBusy(false);
  }

  const calendarQuery = `mode=${draft.mode}&days=${draft.days.join(",")}`;
  const icsHref = `/api/calendar?${calendarQuery}`;

  function onAppleCalendar(e: React.MouseEvent<HTMLAnchorElement>) {
    if (!isIOS) return; // Mac/other: the .ics opens directly
    let seen = false;
    try { seen = localStorage.getItem(IOS_HELP_KEY) === "1"; } catch {}
    if (!seen) { e.preventDefault(); setShowIosHelp(true); }
  }
  function openPreview() {
    try { localStorage.setItem(IOS_HELP_KEY, "1"); } catch {}
    setShowIosHelp(false);
    window.location.assign(window.location.origin + icsHref);
  }

  return (
    <div className="space-y-5">
      {/* Frequency */}
      <fieldset>
        <legend className="eyebrow mb-1">How often</legend>
        <p className="muted text-sm mb-2">Choose how you&apos;d like to be reminded, 10 minutes before the session.</p>
        <div className="flex flex-wrap gap-2">
          {([["next", "Next session only"], ["weekdays", "Selected days"], ["daily", "Every session"]] as const).map(([m, label]) => (
            <button key={m} type="button" className="chip" aria-pressed={draft.mode === m} disabled={busy} onClick={() => setDraft({ ...draft, mode: m })}>{label}</button>
          ))}
        </div>
        {draft.mode === "weekdays" && (
          <div className="flex flex-wrap gap-1 mt-2" role="group" aria-label="Days">
            {DAY_LABELS.map((d, i) => (
              <button key={d} type="button" className="chip px-3" aria-pressed={draft.days.includes(i)} disabled={busy || !schedule.days.includes(i)}
                onClick={() => setDraft({ ...draft, days: draft.days.includes(i) ? draft.days.filter((x) => x !== i) : [...draft.days, i].sort() })}>{d}</button>
            ))}
          </div>
        )}
        <p className="muted text-xs mt-2">This sets how often. It doesn&apos;t add a calendar event or turn on notifications by itself.</p>
      </fieldset>

      {/* App-managed: email + phone, saved explicitly */}
      <div className="space-y-3">
        <p className="eyebrow">Email and phone</p>
        {emailAvailable ? (
          <label className="flex gap-3 items-start cursor-pointer">
            <input type="checkbox" className="mt-1 h-5 w-5 accent-[var(--accent)]" checked={draft.email_enabled} disabled={busy} onChange={(e) => setDraft({ ...draft, email_enabled: e.target.checked })} />
            <span className="text-sm">Email me 10 minutes before the session.</span>
          </label>
        ) : (
          <p className="notice notice-warn text-sm">Email reminders aren&apos;t available on this server yet.</p>
        )}

        {!pushAvailable ? (
          <p className="muted text-sm">Phone notifications aren&apos;t set up on this server yet.</p>
        ) : support.needsInstall ? (
          <div className="notice notice-warn text-sm space-y-1">
            <p>{support.reason}</p>
            <p>In Safari: tap the Share button, then <strong>Add to Home Screen</strong>, open Common Ground from there, and come back to this page to turn notifications on.</p>
          </div>
        ) : !support.supported ? (
          <p className="muted text-sm">{support.reason ?? "This browser can't show notifications."}</p>
        ) : thisDevice ? (
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex gap-3 items-center cursor-pointer text-sm">
              <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={draft.push_enabled} disabled={busy} onChange={(e) => setDraft({ ...draft, push_enabled: e.target.checked })} />
              Phone notification 10 minutes before the session (this device is set up)
            </label>
            <button type="button" className="btn btn-ghost text-sm" disabled={busy} onClick={onDisablePush}>Remove this device</button>
          </div>
        ) : (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onEnablePush}>Enable phone notifications</button>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={savePrefs}>Save reminder preferences</button>
          {saved && !dirty && <span className="muted text-xs">Saved{saved.email_enabled || saved.push_enabled ? "" : " (email and phone reminders are off)"}.</span>}
        </div>
        {msg && <p className={`notice ${msg.kind === "ok" ? "notice-ok" : msg.kind === "warn" ? "notice-warn" : "notice-bad"} text-sm`} role="status">{msg.text}</p>}
        {!compact && <p className="muted text-xs">Push notifications aren&apos;t alarms: your phone&apos;s focus and notification settings decide whether they make a sound. Each device is enabled separately. Every reminder email has a one-click unsubscribe link.</p>}
      </div>

      {/* Calendar (separate from app preferences) */}
      <div className="space-y-2">
        <p className="eyebrow">Calendar</p>
        {showIosHelp ? (
          <IosCalendarHelp onOpen={openPreview} onCancel={() => setShowIosHelp(false)} />
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <a className="btn btn-primary" href={icsHref} onClick={onAppleCalendar}>Add to Apple Calendar</a>
              <a className="btn btn-secondary" href={`${icsHref}&google=1`} target="_blank" rel="noopener">Add to Google Calendar</a>
            </div>
            <p className="muted text-xs">
              <a className="underline" href={icsHref} download>Other calendars (.ics)</a>
              {isIOS && <> · <button type="button" className="underline" onClick={() => setShowIosHelp(true)}>Need help adding it?</button></>}
            </p>
          </>
        )}
        <p className="muted text-xs">Uses the frequency chosen above, shown in your local time, with a 10-minute alert where the calendar app allows it. Imported events are managed in your calendar app; changing settings here doesn&apos;t change them, and they won&apos;t update by themselves if the schedule changes.</p>
      </div>
    </div>
  );
}

// iPhone-only guidance shown before the native calendar preview opens.
function IosCalendarHelp({ onOpen, onCancel }: { onOpen: () => void; onCancel: () => void }) {
  return (
    <div className="card-flat space-y-3" role="dialog" aria-labelledby="ios-help-title">
      <p id="ios-help-title" className="font-semibold">On the next screen, tap <strong>Add To Calendar</strong> at the bottom. The blue checkmark closes the preview without adding the event.</p>
      <svg viewBox="0 0 200 150" className="w-full max-w-[220px] mx-auto" aria-hidden="true">
        <rect x="20" y="4" width="160" height="142" rx="18" fill="var(--card)" stroke="var(--line)" strokeWidth="2" />
        <circle cx="160" cy="24" r="10" fill="#8fb4f0" opacity=".5" />
        <path d="M155 24l4 4 7-8" stroke="#fff" strokeWidth="2" fill="none" />
        <text x="162" y="48" fontSize="7" textAnchor="middle" fill="var(--muted)">closes only</text>
        <rect x="34" y="40" width="90" height="8" rx="4" fill="var(--bg-2)" />
        <rect x="34" y="54" width="70" height="6" rx="3" fill="var(--bg-2)" />
        <rect x="34" y="72" width="132" height="22" rx="6" fill="var(--sage-2)" />
        <rect x="44" y="118" width="112" height="20" rx="10" fill="var(--accent)" />
        <text x="100" y="132" fontSize="9" textAnchor="middle" fill="var(--accent-fg)" fontWeight="700">Add To Calendar</text>
        <rect x="40" y="114" width="120" height="28" rx="14" fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3" />
      </svg>
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary flex-1" onClick={onOpen}>Open calendar preview</button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
