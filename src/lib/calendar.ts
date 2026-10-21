// Calendar export for the shared session. Events are anchored to the schedule
// timezone (TZID) so recurring entries follow daylight saving exactly like the
// real session; the same wall-clock rule is embedded as a VTIMEZONE.
import { nextSessions, type ScheduleConfig, type Session } from "./schedule";

export type CalendarMode = "next" | "weekdays" | "daily";
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function pad(n: number) { return String(n).padStart(2, "0"); }
function wallClock(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return `${o.year}${o.month}${o.day}T${o.hour}${o.minute}${o.second}`;
}
function utcStamp(ms: number) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
function escapeText(s: string) { return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n"); }

// Standard US Pacific rules; other zones get a floating-time fallback with an
// explicit note in the description. (Pilot schedule is Pacific-anchored.)
const VTIMEZONES: Record<string, string> = {
  "America/Los_Angeles": [
    "BEGIN:VTIMEZONE", "TZID:America/Los_Angeles",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0800", "TZOFFSETTO:-0700", "TZNAME:PDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:-0700", "TZOFFSETTO:-0800", "TZNAME:PST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
    "END:VTIMEZONE",
  ].join("\r\n"),
};

export function rrule(mode: CalendarMode, days: number[], cfg: ScheduleConfig): string | null {
  if (mode === "next") return null;
  const allowed = days.filter((d) => cfg.days.includes(d));
  if (mode === "daily") return cfg.days.length === 7 ? "RRULE:FREQ=DAILY" : `RRULE:FREQ=WEEKLY;BYDAY=${cfg.days.map((d) => BYDAY[d]).join(",")}`;
  if (!allowed.length) return null;
  return `RRULE:FREQ=WEEKLY;BYDAY=${allowed.map((d) => BYDAY[d]).join(",")}`;
}

// Stable UID per (mode, days): re-importing the same choice updates rather
// than duplicates in calendar apps that honour UID.
export function calendarUid(mode: CalendarMode, days: number[], host: string) {
  const key = mode === "weekdays" ? `weekdays-${[...days].sort().join("")}` : mode;
  return `common-ground-session-${key}@${host}`;
}

// Effective days for a mode: all session days for next/daily, the chosen
// session days for weekdays. Returns null when nothing is selected.
export function effectiveDays(mode: CalendarMode, days: number[], cfg: ScheduleConfig): number[] | null {
  if (mode === "weekdays") {
    const d = days.filter((x) => cfg.days.includes(x));
    return d.length ? d : null;
  }
  return cfg.days.length ? cfg.days : null;
}

// First upcoming session that falls on one of the effective days.
export function firstSession(mode: CalendarMode, days: number[], cfg: ScheduleConfig, nowMs: number): Session | null {
  const eff = effectiveDays(mode, days, cfg);
  if (!eff) return null;
  return nextSessions(nowMs, 14, { ...cfg, days: eff })[0] ?? null;
}

export function buildIcs(opts: { mode: CalendarMode; days: number[]; cfg: ScheduleConfig; siteUrl: string; nowMs?: number }): string {
  const { mode, days, cfg, siteUrl } = opts;
  const now = opts.nowMs ?? Date.now();
  const first: Session | null = firstSession(mode, days, cfg, now);
  if (!first) throw new Error("no day selected");
  const host = new URL(siteUrl).host;
  const tzBlock = VTIMEZONES[cfg.timezone];
  const dtstart = tzBlock ? `DTSTART;TZID=${cfg.timezone}:${wallClock(first.start, cfg.timezone)}` : `DTSTART:${utcStamp(first.start)}`;
  const dtend = tzBlock ? `DTEND;TZID=${cfg.timezone}:${wallClock(first.end, cfg.timezone)}` : `DTEND:${utcStamp(first.end)}`;
  const rule = rrule(mode, days, cfg);
  const desc = [
    "The shared conversation hour on Common Ground. Join at the start for the best chance of a match.",
    `Open: ${siteUrl}/lobby`,
    "",
    "This event was downloaded from Common Ground. Your calendar app controls the alert. If the schedule changes, this event does not update by itself; download a new one.",
  ].join("\n");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Common Ground//Session//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    ...(tzBlock ? [tzBlock] : []),
    "BEGIN:VEVENT",
    `UID:${calendarUid(mode, days, host)}`,
    `DTSTAMP:${utcStamp(now)}`,
    dtstart, dtend,
    ...(rule ? [rule] : []),
    `SUMMARY:${escapeText("Common Ground conversation hour")}`,
    `DESCRIPTION:${escapeText(desc)}`,
    `URL:${siteUrl}/lobby`,
    `LOCATION:${siteUrl}/lobby`,
    "BEGIN:VALARM", "TRIGGER:-PT10M", "ACTION:DISPLAY", "DESCRIPTION:Common Ground starts in 10 minutes", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

export function googleCalendarUrl(opts: { mode: CalendarMode; days: number[]; cfg: ScheduleConfig; siteUrl: string; nowMs?: number }): string {
  const first = firstSession(opts.mode, opts.days, opts.cfg, opts.nowMs ?? Date.now());
  if (!first) throw new Error("no day selected");
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: "Common Ground conversation hour",
    dates: `${utcStamp(first.start)}/${utcStamp(first.end)}`,
    ctz: opts.cfg.timezone,
    details: `The shared conversation hour on Common Ground. Join at the start for the best chance of a match.\n${opts.siteUrl}/lobby`,
    location: `${opts.siteUrl}/lobby`,
  });
  const rule = rrule(opts.mode, opts.days, opts.cfg);
  if (rule) p.set("recur", rule);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}
