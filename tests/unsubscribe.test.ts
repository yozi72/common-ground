import { describe, it, expect } from "vitest";
import { unsubscribeToken, verifyUnsubscribeToken } from "@/lib/unsubscribe";

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
});
