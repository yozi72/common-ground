import { describe, it, expect } from "vitest";
import { pickNextReminderSession, DEFAULT_SCHEDULE } from "@/lib/schedule";
import { parseDaysParam } from "@/lib/calendar";

describe("next-session-only target (server-side)", () => {
  const start = Date.parse("2026-10-21T01:00:00Z"); // Oct 20 18:00 PDT
  it("skips the session already underway and one whose reminder time has passed", () => {
    expect(pickNextReminderSession(start + 30 * 60_000, 10)?.start).toBe(start + 86_400_000); // 6:30 pm → tomorrow
    expect(pickNextReminderSession(start - 5 * 60_000, 10)?.start).toBe(start + 86_400_000); // 5:55 pm: 10-min reminder already passed
    expect(pickNextReminderSession(start - 20 * 60_000, 10)?.start).toBe(start);              // 5:40 pm: today still qualifies
    expect(pickNextReminderSession(start - 12 * 60_000, 10)?.start).toBe(start);              // 5:48 pm: 2 min of margin left
  });
  it("returns null when no session is scheduled", () => {
    expect(pickNextReminderSession(start, 10, { ...DEFAULT_SCHEDULE, days: [] })).toBeNull();
  });
});

describe("calendar days query parsing", () => {
  it("never turns an empty value into Sunday and rejects junk", () => {
    expect(parseDaysParam("")).toEqual([]);
    expect(parseDaysParam(null)).toEqual([]);
    expect(parseDaysParam(",")).toEqual([]);
    expect(parseDaysParam("1,3,5")).toEqual([1, 3, 5]);
    expect(parseDaysParam("1,1")).toEqual([1]);
    expect(parseDaysParam("7")).toBeNull();
    expect(parseDaysParam("a")).toBeNull();
    expect(parseDaysParam("0x1")).toBeNull();
  });
});
