import { describe, it, expect } from "vitest";
import { buildIcs, googleCalendarUrl, calendarUid } from "@/lib/calendar";
import { DEFAULT_SCHEDULE } from "@/lib/schedule";

const SITE = "https://app.example";
const now = Date.parse("2026-10-20T12:00:00Z"); // before the Oct 20 session (18:00 PDT = 01:00Z Oct 21)

describe("calendar export", () => {
  it("anchors the event to the Pacific wall clock with a VTIMEZONE and a 10-minute alarm", () => {
    const ics = buildIcs({ mode: "daily", days: [], cfg: DEFAULT_SCHEDULE, siteUrl: SITE, nowMs: now });
    expect(ics).toContain("DTSTART;TZID=America/Los_Angeles:20261020T180000");
    expect(ics).toContain("DTEND;TZID=America/Los_Angeles:20261020T190000");
    expect(ics).toContain("RRULE:FREQ=DAILY");
    expect(ics).toContain("TRIGGER:-PT10M");
    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).toContain("RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU"); // fall back rule
    expect(ics).toContain(`URL:${SITE}/lobby`);
  });

  it("recurring events stay aligned across the DST change (same wall clock, offset handled by TZID)", () => {
    // The event is defined by wall clock + TZID, so Dec occurrences are 18:00 PST (02:00Z) without any change.
    const ics = buildIcs({ mode: "daily", days: [], cfg: DEFAULT_SCHEDULE, siteUrl: SITE, nowMs: now });
    expect(ics).not.toMatch(/DTSTART:\d{8}T\d{6}Z/); // never a fixed-UTC start for a recurring event
  });

  it("next-only has no RRULE; weekdays limits BYDAY to chosen days that are session days", () => {
    const next = buildIcs({ mode: "next", days: [], cfg: DEFAULT_SCHEDULE, siteUrl: SITE, nowMs: now });
    expect(next).not.toMatch(/RRULE:FREQ=(DAILY|WEEKLY)/);
    const wk = buildIcs({ mode: "weekdays", days: [1, 3, 5], cfg: DEFAULT_SCHEDULE, siteUrl: SITE, nowMs: now });
    expect(wk).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR");
    const limited = buildIcs({ mode: "weekdays", days: [0, 6], cfg: { ...DEFAULT_SCHEDULE, days: [1, 2, 3, 4, 5] }, siteUrl: SITE, nowMs: Date.parse("2026-10-19T12:00:00Z") });
    expect(limited).not.toMatch(/RRULE:FREQ=(DAILY|WEEKLY)/); // no overlap → single event
  });

  it("uses a stable UID per choice so re-imports replace instead of duplicating", () => {
    expect(calendarUid("weekdays", [5, 1], "h")).toBe(calendarUid("weekdays", [1, 5], "h"));
    expect(calendarUid("daily", [], "h")).not.toBe(calendarUid("next", [], "h"));
  });

  it("google link carries UTC dates, the schedule ctz and the recurrence", () => {
    const u = new URL(googleCalendarUrl({ mode: "daily", days: [], cfg: DEFAULT_SCHEDULE, siteUrl: SITE, nowMs: now }));
    expect(u.searchParams.get("dates")).toBe("20261021T010000Z/20261021T020000Z");
    expect(u.searchParams.get("ctz")).toBe("America/Los_Angeles");
    expect(u.searchParams.get("recur")).toBe("RRULE:FREQ=DAILY");
  });
});
