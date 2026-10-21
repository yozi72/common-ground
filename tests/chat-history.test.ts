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

import { gapCursor, newerFilter, reconcile, rangeOfNewestPage, rangeOfOlderPage, rangeOfNewerPage, withoutIds } from "@/lib/chat-history";

describe("chat history: gaps after a disconnect and deletions (audit)", () => {
  it("detects a gap larger than one page and catches up forward until the ranges meet", () => {
    // cache 1..200 (and the client believes there is nothing earlier)
    let have = mergeMessages([], range(1, 200));
    // 300 messages arrive while disconnected; refresh returns the newest page 301..500
    const newest = range(301, 500).reverse();
    expect(gapCursor(have, newest)).toEqual({ created_at: msg(200).created_at, id: "m0200" });
    have = reconcile(have, newest, rangeOfNewestPage(newest));
    // forward pages from the cursor: 201..400, then 401..500 overlaps the newest page
    let cursor = gapCursor(mergeMessages([], range(1, 200)), newest)!;
    expect(newerFilter(cursor)).toBe(`created_at.gt.${msg(200).created_at},and(created_at.eq.${msg(200).created_at},id.gt.m0200)`);
    const page1 = range(201, 400);
    have = reconcile(have, page1, rangeOfNewerPage(page1, cursor));
    cursor = { created_at: msg(400).created_at, id: "m0400" };
    const page2 = range(401, 500); // short page: the server has nothing newer
    have = reconcile(have, page2, rangeOfNewerPage(page2, cursor));
    expect(have.length).toBe(500);
    expect(ids(have).slice(199, 203)).toEqual(["m0200", "m0201", "m0202", "m0203"]);
    // no gap when the ranges overlap, or when the newest page is short
    expect(gapCursor(range(1, 300), range(201, 400).reverse())).toBeNull();
    expect(gapCursor(range(1, 200), range(201, 250).reverse())).toBeNull();
    expect(gapCursor([], newest)).toBeNull();
  });

  it("drops a message deleted inside the refreshed newest page, keeps older history", () => {
    let have = mergeMessages([], range(1, 400));
    const newest = range(201, 400).filter((m) => m.id !== "m0350").reverse(); // 350 was deleted server-side
    have = reconcile(have, newest, rangeOfNewestPage(newest));
    expect(ids(have)).not.toContain("m0350");
    expect(ids(have)).toContain("m0100"); // outside the page's range: absence proves nothing
    expect(have.length).toBe(399);
  });

  it("drops a message deleted inside an older page's range and respects the exclusive cursor", () => {
    let have = mergeMessages([], range(1, 400));
    const cursor = { created_at: msg(201).created_at, id: "m0201" };
    const older = range(1, 200).filter((m) => m.id !== "m0150").reverse();
    have = reconcile(have, older, rangeOfOlderPage(older, cursor));
    expect(ids(have)).not.toContain("m0150");
    expect(ids(have)).toContain("m0201");
    expect(ids(have)).toContain("m0300");
    expect(have.length).toBe(399);
    // a short older page extends the proven range to the beginning of history
    const shortOlder = range(2, 200).reverse();                // m0001 vanished (retention)
    have = reconcile(have, shortOlder, rangeOfOlderPage(shortOlder, cursor));
    expect(ids(have)).not.toContain("m0001");
  });

  it("does not drop older history when it just fell out of the newest page", () => {
    let have = mergeMessages([], range(1, 400));
    const newest = range(202, 401).reverse();                  // 401 arrived; 201 is now older than the page
    have = reconcile(have, newest, rangeOfNewestPage(newest));
    expect(ids(have)).toContain("m0201");
    expect(have.length).toBe(401);
  });

  it("removes explicitly deleted ids (realtime DELETE, id verification)", () => {
    const have = mergeMessages([], range(1, 5));
    expect(ids(withoutIds(have, ["m0002", "nope"]))).toEqual(["m0001", "m0003", "m0004", "m0005"]);
  });

  it("messages arriving during pagination are merged, not lost", () => {
    let have = mergeMessages([], range(201, 400));
    const cursor = { created_at: msg(201).created_at, id: "m0201" };
    const older = range(1, 200).reverse();
    have = reconcile(have, older, rangeOfOlderPage(older, cursor));
    const newest = range(202, 401).reverse();                  // arrived meanwhile
    have = reconcile(have, newest, rangeOfNewestPage(newest));
    expect(have.length).toBe(401);
  });
});
