import { describe, it, expect } from "vitest";
import { nextOnlyExpired } from "@/lib/reminder-state";

describe("next-session-only reminder expiry", () => {
  const now = Date.parse("2026-10-21T02:00:00Z"); // after the Oct 20 session (01:00Z–02:00Z)
  it("is spent once the saved session has started, and renewable", () => {
    expect(nextOnlyExpired({ mode: "next", next_session_start: "2026-10-21T01:00:00Z", email_enabled: true, push_enabled: false }, now)).toBe(true);
    expect(nextOnlyExpired({ mode: "next", next_session_start: "2026-10-22T01:00:00Z", email_enabled: true, push_enabled: false }, now)).toBe(false);
    expect(nextOnlyExpired({ mode: "next", next_session_start: null, email_enabled: true, push_enabled: false }, now)).toBe(true);
  });
  it("does not apply to recurring modes or when nothing is enabled", () => {
    expect(nextOnlyExpired({ mode: "daily", next_session_start: null, email_enabled: true, push_enabled: false }, now)).toBe(false);
    expect(nextOnlyExpired({ mode: "next", next_session_start: "2026-10-21T01:00:00Z", email_enabled: false, push_enabled: false }, now)).toBe(false);
    expect(nextOnlyExpired(null, now)).toBe(false);
  });
});
