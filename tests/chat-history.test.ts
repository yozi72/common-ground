import { describe, it, expect } from "vitest";
import { mergeMessages, olderCursor, olderFilter, reachedStart, readMarkFor, readMarkAfter, PAGE_SIZE } from "@/lib/chat-history";

const msg = (n: number, at?: string) => ({ id: `m${String(n).padStart(4, "0")}`, created_at: at ?? new Date(Date.UTC(2026, 9, 20, 0, 0, n)).toISOString(), body: `msg ${n}` });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
const ids = (ms: { id: string }[]) => ms.map((m) => m.id);

describe("chat history: merge, paging, read marks (fifth review)", () => {
  it("keeps message 201 when message 401 arrives after two pages were loaded", () => {
    // newest page 201..400, then an older page 1..200
    let have = mergeMessages([], range(201, 400).reverse());
    have = mergeMessages(have, range(1, 200).reverse());
    expect(have.length).toBe(400);
    // message 401 arrives: the newest page is now 202..401 and no longer contains 201
    have = mergeMessages(have, range(202, 401).reverse());
    expect(have.length).toBe(401);
    expect(ids(have)).toContain("m0201");
    expect(ids(have)[0]).toBe("m0001");
    expect(ids(have)[400]).toBe("m0401");
  });

  it("overlapping refreshes and pages deduplicate by id", () => {
    let have = mergeMessages([], range(150, 349));
    have = mergeMessages(have, range(150, 349));              // same page twice
    have = mergeMessages(have, range(100, 299));              // overlapping older page
    expect(have.length).toBe(250);
    expect(new Set(ids(have)).size).toBe(250);
  });

  it("orders identical timestamps by id and pages past them with a (created_at, id) cursor", () => {
    const t = "2026-10-20T00:00:05.000Z";
    const have = mergeMessages([], [msg(3, t), msg(1, t), msg(2, t), msg(0, "2026-10-20T00:00:04.000Z")]);
    expect(ids(have)).toEqual(["m0000", "m0001", "m0002", "m0003"]);
    const cursor = olderCursor(have.slice(2)); // we only have m0002, m0003 loaded
    expect(cursor).toEqual({ created_at: t, id: "m0002" });
    expect(olderFilter(cursor!)).toBe(`created_at.lt.${t},and(created_at.eq.${t},id.lt.m0002)`);
  });

  it("knows when the beginning of history was reached", () => {
    expect(reachedStart(PAGE_SIZE)).toBe(false);
    expect(reachedStart(PAGE_SIZE - 1)).toBe(true);
    expect(reachedStart(0)).toBe(true);
    expect(olderCursor([])).toBeNull();
  });

  it("marks read only on a successful, visible load, and retries after a failed request", () => {
    const base = { kind: "friend", loadFailed: false, newest: "2026-10-20T00:00:09.000Z", visible: true, lastSent: null };
    expect(readMarkFor(base)).toBe(base.newest);
    expect(readMarkFor({ ...base, visible: false })).toBeNull();
    expect(readMarkFor({ ...base, loadFailed: true })).toBeNull();
    expect(readMarkFor({ ...base, kind: "live" })).toBeNull();
    expect(readMarkFor({ ...base, newest: null })).toBeNull();
    expect(readMarkFor({ ...base, lastSent: base.newest })).toBeNull();      // already sent for this bound
    // the request came back 500 → the bound is cleared, so the next load sends it again
    expect(readMarkAfter(base.newest, false)).toBeNull();
    expect(readMarkFor({ ...base, lastSent: readMarkAfter(base.newest, false) })).toBe(base.newest);
    expect(readMarkAfter(base.newest, true)).toBe(base.newest);
  });
});
