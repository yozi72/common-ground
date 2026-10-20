import { describe, it, expect } from "vitest";
import { DEFAULT_SCHEDULE, sessionState, nextSessions, zonedTimeToUtc, sessionDueForReminder, formatSessionTime, dateKeyOf, type ScheduleConfig } from "@/lib/schedule";

const LA = "America/Los_Angeles";
const utc = (s: string) => Date.parse(s);

describe("schedule: LA-anchored daily session", () => {
  it("6pm LA is 9pm New York, 8pm Chicago, 7pm Denver on the same instant (PDT)", () => {
    const st = sessionState(utc("2026-10-20T20:00:00Z"));
    expect(st.phase).toBe("before");
    const s = st.phase === "before" ? st.next : null;
    expect(s!.start).toBe(utc("2026-10-21T01:00:00Z")); // 18:00 PDT = 01:00Z next day
    expect(formatSessionTime(s!, "America/New_York", LA).range).toBe("9:00 PM–10:00 PM");
    expect(formatSessionTime(s!, "America/Chicago", LA).range).toBe("8:00 PM–9:00 PM");
    expect(formatSessionTime(s!, "America/Denver", LA).range).toBe("7:00 PM–8:00 PM");
    expect(formatSessionTime(s!, LA, LA).range).toBe("6:00 PM–7:00 PM");
  });

  it("follows LA daylight saving: PDT in October, PST in December", () => {
    const oct = sessionState(utc("2026-10-20T12:00:00Z"));
    const dec = sessionState(utc("2026-12-20T12:00:00Z"));
    expect(oct.phase === "before" && oct.next.start).toBe(utc("2026-10-21T01:00:00Z"));
    expect(dec.phase === "before" && dec.next.start).toBe(utc("2026-12-21T02:00:00Z")); // 18:00 PST = 02:00Z
  });

  it("is open during the hour and reports time remaining; closed after", () => {
    const start = utc("2026-10-21T01:00:00Z");
    const mid = sessionState(start + 30 * 60_000);
    expect(mid.phase).toBe("open");
    expect(mid.phase === "open" && mid.msUntilEnd).toBe(30 * 60_000);
    const after = sessionState(start + 61 * 60_000);
    expect(after.phase).toBe("before");
    expect(after.phase === "before" && after.next.start).toBe(start + 86_400_000); // next day, same offset in Oct
    const justBefore = sessionState(start - 1);
    expect(justBefore.phase).toBe("before");
    expect(justBefore.phase === "before" && justBefore.msUntilStart).toBe(1);
  });

  it("Arizona (no DST) shows 7pm in October and 7pm in December for the same session? No: 7pm PDT-era, 7pm PST-era differ", () => {
    const oct = nextSessions(utc("2026-10-20T12:00:00Z"), 1)[0];
    const dec = nextSessions(utc("2026-12-20T12:00:00Z"), 1)[0];
    expect(formatSessionTime(oct, "America/Phoenix", LA).range).toBe("6:00 PM–7:00 PM"); // MST = PDT in October
    expect(formatSessionTime(dec, "America/Phoenix", LA).range).toBe("7:00 PM–8:00 PM"); // MST vs PST in December
  });

  it("Hawaii sees 3pm (PDT) / 4pm (PST) and the same calendar date; New York can be a different date? Same date here", () => {
    const oct = nextSessions(utc("2026-10-20T12:00:00Z"), 1)[0];
    expect(formatSessionTime(oct, "Pacific/Honolulu", LA).range).toBe("3:00 PM–4:00 PM");
    expect(formatSessionTime(oct, "Pacific/Honolulu", LA).startsOnDifferentDate).toBe(false);
    // Tokyo is on the next calendar date
    expect(formatSessionTime(oct, "Asia/Tokyo", LA).startsOnDifferentDate).toBe(true);
    expect(dateKeyOf(oct.start, "Asia/Tokyo")).toBe("2026-10-21");
    expect(dateKeyOf(oct.start, LA)).toBe("2026-10-20");
  });

  it("midnight crossing: a 23:30 LA session that runs past midnight is still found while open", () => {
    const cfg: ScheduleConfig = { ...DEFAULT_SCHEDULE, startTime: "23:30" };
    const start = zonedTimeToUtc(2026, 10, 20, 23, 30, LA); // 06:30Z on the 21st
    const st = sessionState(start + 45 * 60_000, cfg); // 00:15 LA on the 21st
    expect(st.phase).toBe("open");
    expect(st.phase === "open" && st.current.dateKey).toBe("2026-10-20");
  });

  it("respects configured days (weekdays only)", () => {
    const cfg: ScheduleConfig = { ...DEFAULT_SCHEDULE, days: [1, 2, 3, 4, 5] };
    // Saturday 2026-10-24 noon LA → next session Monday 2026-10-26
    const st = sessionState(utc("2026-10-24T19:00:00Z"), cfg);
    expect(st.phase === "before" && st.next.dateKey).toBe("2026-10-26");
    expect(sessionState(utc("2026-10-24T19:00:00Z"), { ...cfg, days: [] }).phase).toBe("none");
  });

  it("spring-forward: a session on the DST change day keeps 6pm wall clock", () => {
    // 2027-03-14 is the US spring-forward date
    const s = nextSessions(utc("2027-03-14T12:00:00Z"), 1)[0];
    expect(formatSessionTime(s, LA, LA).range).toBe("6:00 PM–7:00 PM");
    expect(s.start).toBe(utc("2027-03-15T01:00:00Z")); // PDT already
  });

  it("reminder window: due 10 minutes before, not after start, only once per window", () => {
    const start = utc("2026-10-21T01:00:00Z");
    expect(sessionDueForReminder(start - 11 * 60_000, 10)).toBeNull();
    expect(sessionDueForReminder(start - 10 * 60_000, 10)?.start).toBe(start);
    expect(sessionDueForReminder(start - 6 * 60_000, 10)?.start).toBe(start);
    expect(sessionDueForReminder(start - 4 * 60_000, 10)).toBeNull(); // window closed (5 min)
    expect(sessionDueForReminder(start + 1, 10)).toBeNull();
  });
});
