import { describe, it, expect } from "vitest";
import { safeNext } from "@/lib/safe-next";

const SITE = "https://app.example";

describe("safeNext", () => {
  it("keeps ordinary internal paths", () => {
    expect(safeNext("/lobby", SITE)).toBe("/lobby");
    expect(safeNext("/c/123?x=1", SITE)).toBe("/c/123?x=1");
    expect(safeNext("/settings#a", SITE)).toBe("/settings");
  });
  it("falls back for missing or malformed values", () => {
    expect(safeNext(null, SITE)).toBe("/lobby");
    expect(safeNext("", SITE)).toBe("/lobby");
    expect(safeNext("lobby", SITE)).toBe("/lobby");
    expect(safeNext("/lob by", SITE)).toBe("/lobby");
  });
  it("rejects absolute and protocol-relative destinations", () => {
    expect(safeNext("https://evil.example/", SITE)).toBe("/lobby");
    expect(safeNext("//evil.example", SITE)).toBe("/lobby");
    expect(safeNext("/\\evil.example", SITE)).toBe("/lobby");
    expect(safeNext("javascript:alert(1)", SITE)).toBe("/lobby");
  });
  it("rejects paths that normalize to a protocol-relative URL (review finding)", () => {
    expect(safeNext("/a/..//example.org", SITE)).toBe("/lobby");
    expect(safeNext("/a/b/../..//example.org/x", SITE)).toBe("/lobby");
    expect(safeNext("/%2F%2Fexample.org", SITE)).toBe("/%2F%2Fexample.org"); // stays on-site as a literal path
    expect(new URL(safeNext("/a/..//example.org", SITE), SITE).origin).toBe(SITE);
  });
});
