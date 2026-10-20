// One shared daily session, anchored to a wall-clock time in a schedule
// timezone (default America/Los_Angeles). Pure functions, used by the server
// (eligibility, reminders), the client (countdowns), and calendar exports.
//
// All instants are UTC epoch milliseconds. Wall-clock → instant conversion is
// done with Intl so daylight-saving transitions follow the real tz database.

export type ScheduleConfig = {
  days: number[];            // 0 = Sunday … 6 = Saturday, in the schedule timezone
  startTime: string;         // "HH:MM" in the schedule timezone
  durationMinutes: number;
  timezone: string;          // IANA, e.g. "America/Los_Angeles"
};

export const DEFAULT_SCHEDULE: ScheduleConfig = { days: [0, 1, 2, 3, 4, 5, 6], startTime: "18:00", durationMinutes: 60, timezone: "America/Los_Angeles" };

export type Session = { start: number; end: number; dateKey: string };

export type SessionState =
  | { phase: "before"; next: Session; msUntilStart: number }
  | { phase: "open"; current: Session; msUntilEnd: number; next: Session | null }
  | { phase: "none"; next: null };

// Parts of an instant in a timezone.
function partsIn(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute, ss: +o.second, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday) };
}

// UTC instant for a wall-clock time in tz. Iterates once to absorb the offset
// (correct across DST, including the spring-forward gap and fall-back overlap:
// a time in the gap maps forward; in the overlap we take the first occurrence).
export function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = partsIn(guess, tz);
    const wall = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
    const diff = wall - target; // how far the wall clock at `guess` is from the wanted wall clock
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

export function dateKeyOf(ms: number, tz: string) {
  const p = partsIn(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function sessionOnDate(y: number, m: number, d: number, cfg: ScheduleConfig): Session {
  const [hh, mm] = cfg.startTime.split(":").map(Number);
  const start = zonedTimeToUtc(y, m, d, hh, mm, cfg.timezone);
  return { start, end: start + cfg.durationMinutes * 60_000, dateKey: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

// Sessions on the schedule days, from the day before `fromMs` (in tz) forward.
function* sessionsFrom(fromMs: number, cfg: ScheduleConfig, limitDays = 14): Generator<Session> {
  const p = partsIn(fromMs, cfg.timezone);
  // start a day early so a session that began "yesterday" in tz and is still open is found
  let cursor = Date.UTC(p.y, p.m - 1, p.d) - 86_400_000;
  for (let i = 0; i < limitDays + 1; i++) {
    const c = new Date(cursor);
    const y = c.getUTCFullYear(), m = c.getUTCMonth() + 1, d = c.getUTCDate();
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (cfg.days.includes(weekday)) yield sessionOnDate(y, m, d, cfg);
    cursor += 86_400_000;
  }
}

export function sessionState(nowMs: number, cfg: ScheduleConfig = DEFAULT_SCHEDULE): SessionState {
  if (!cfg.days.length) return { phase: "none", next: null };
  let current: Session | null = null;
  let next: Session | null = null;
  for (const s of sessionsFrom(nowMs, cfg)) {
    if (s.start <= nowMs && nowMs < s.end) { current = s; continue; }
    if (s.start > nowMs) { next = s; break; }
  }
  if (current) return { phase: "open", current, msUntilEnd: current.end - nowMs, next };
  if (next) return { phase: "before", next, msUntilStart: next.start - nowMs };
  return { phase: "none", next: null };
}

export function nextSessions(nowMs: number, count: number, cfg: ScheduleConfig = DEFAULT_SCHEDULE): Session[] {
  const out: Session[] = [];
  for (const s of sessionsFrom(nowMs, cfg, count + 8)) {
    if (s.end > nowMs) out.push(s);
    if (out.length >= count) break;
  }
  return out;
}

// Session that should be reminded about at `nowMs` given a lead time, if any.
export function sessionDueForReminder(nowMs: number, minutesBefore: number, cfg: ScheduleConfig = DEFAULT_SCHEDULE, windowMs = 5 * 60_000): Session | null {
  for (const s of sessionsFrom(nowMs, cfg)) {
    const fireAt = s.start - minutesBefore * 60_000;
    if (nowMs >= fireAt && nowMs < Math.min(fireAt + windowMs, s.start)) return s;
    if (fireAt > nowMs) return null;
  }
  return null;
}

// Formatting helpers for the UI. `viewerTz` is the device or override tz.
export function formatSessionTime(s: Session, viewerTz: string, scheduleTz: string) {
  const t = new Intl.DateTimeFormat("en-US", { timeZone: viewerTz, hour: "numeric", minute: "2-digit" });
  const d = new Intl.DateTimeFormat("en-US", { timeZone: viewerTz, weekday: "short", month: "short", day: "numeric" });
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone: viewerTz, timeZoneName: "short" }).formatToParts(new Date(s.start)).find((p) => p.type === "timeZoneName")?.value ?? viewerTz;
  const sameDate = dateKeyOf(s.start, viewerTz) === dateKeyOf(s.start, scheduleTz);
  return { range: `${t.format(s.start)}–${t.format(s.end)}`, date: d.format(s.start), tzName, startsOnDifferentDate: !sameDate };
}

export function partsWeekday(ms: number, tz: string) {
  return partsIn(ms, tz).weekday;
}

export function isValidTimeZone(tz: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export function formatCountdown(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
