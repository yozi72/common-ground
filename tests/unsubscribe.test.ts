import { describe, it, expect } from "vitest";
import { unsubscribeToken, verifyUnsubscribeToken, secretsEqual } from "@/lib/unsubscribe";

describe("reminder email unsubscribe tokens", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  it("round-trips and rejects tampering or other secrets", () => {
    const t = unsubscribeToken(id, "s1");
    expect(verifyUnsubscribeToken(t, "s1")).toBe(id);
    expect(verifyUnsubscribeToken(t, "s2")).toBeNull();
    expect(verifyUnsubscribeToken(t.slice(0, -1) + "x", "s1")).toBeNull();
    expect(verifyUnsubscribeToken(t.replace(id, "123e4567-e89b-12d3-a456-426614174001"), "s1")).toBeNull();
    expect(verifyUnsubscribeToken("garbage", "s1")).toBeNull();
    expect(verifyUnsubscribeToken("", "s1")).toBeNull();
  });
  it("uses the dedicated secret and accepts links signed with the previous one during a rotation", () => {
    const prevCron = process.env.CRON_SECRET, prevUnsub = process.env.REMINDER_UNSUB_SECRET, prevPrev = process.env.REMINDER_UNSUB_SECRET_PREVIOUS;
    try {
      process.env.CRON_SECRET = "cron-secret"; process.env.REMINDER_UNSUB_SECRET = "new-unsub"; delete process.env.REMINDER_UNSUB_SECRET_PREVIOUS;
      const fresh = unsubscribeToken(id);
      expect(verifyUnsubscribeToken(fresh)).toBe(id);
      expect(verifyUnsubscribeToken(unsubscribeToken(id, "cron-secret"))).toBeNull();      // never the cron secret
      const old = unsubscribeToken(id, "old-unsub");
      expect(verifyUnsubscribeToken(old)).toBeNull();
      process.env.REMINDER_UNSUB_SECRET_PREVIOUS = "old-unsub";
      expect(verifyUnsubscribeToken(old)).toBe(id);                                        // rotation window
      expect(verifyUnsubscribeToken(fresh)).toBe(id);
    } finally {
      process.env.CRON_SECRET = prevCron; process.env.REMINDER_UNSUB_SECRET = prevUnsub;
      if (prevPrev === undefined) delete process.env.REMINDER_UNSUB_SECRET_PREVIOUS; else process.env.REMINDER_UNSUB_SECRET_PREVIOUS = prevPrev;
    }
  });
});

describe("cron secret comparison", () => {
  it("is safe with missing values and unequal lengths, and exact otherwise", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("ab", "abc")).toBe(false);
    expect(secretsEqual("", "abc")).toBe(false);
    expect(secretsEqual(null, "abc")).toBe(false);
    expect(secretsEqual("abc", undefined)).toBe(false);
    expect(secretsEqual(undefined, undefined)).toBe(false);
    expect(secretsEqual("", "")).toBe(false);
  });
});
