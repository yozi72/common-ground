import { describe, it, expect } from "vitest";
import { ChatSync, type Fetchers, type Cursor } from "@/lib/chat-sync";
import { compareMsgs } from "@/lib/chat-history";

type M = { id: string; created_at: string; body: string };
const msg = (n: number): M => ({ id: `m${String(n).padStart(4, "0")}`, created_at: new Date(Date.UTC(2026, 9, 20, 0, 0, n)).toISOString(), body: `msg ${n}` });
const ids = (ms: M[]) => ms.map((m) => m.id);
const PAGE = 200;

// A tiny in-memory server with controllable failures and delays.
function server(initial: M[]) {
  let rows = initial.slice().sort(compareMsgs);
  const failNext = { latest: 0, newer: 0, older: 0, existing: 0 };
  const gates: { latest?: () => Promise<void> } = {};
  const after = (c: Cursor) => rows.filter((m) => compareMsgs(m, c as M) > 0);
  const before = (c: Cursor) => rows.filter((m) => compareMsgs(m, c as M) < 0);
  const f: Fetchers<M> = {
    latest: async () => { if (gates.latest) await gates.latest(); if (failNext.latest-- > 0) return { data: null, error: "boom" }; return { data: rows.slice().reverse().slice(0, PAGE), error: null }; },
    newer: async (c) => { if (failNext.newer-- > 0) return { data: null, error: "boom" }; return { data: after(c).slice(0, PAGE), error: null }; },
    older: async (c) => { if (failNext.older-- > 0) return { data: null, error: "boom" }; return { data: before(c).reverse().slice(0, PAGE), error: null }; },
    existing: async (q) => { if (failNext.existing-- > 0) return { data: null, error: "boom" }; const have = new Set(rows.map((m) => m.id)); return { data: q.filter((id) => have.has(id)).map((id) => ({ id })), error: null }; },
  };
  return { f, failNext, gates, add: (ms: M[]) => { rows = [...rows, ...ms].sort(compareMsgs); }, remove: (idsToDrop: string[]) => { const d = new Set(idsToDrop); rows = rows.filter((m) => !d.has(m.id)); }, rows: () => rows };
}
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => msg(a + i));

describe("chat sync orchestration (audit 11)", () => {
  it("a failed catch-up keeps the gap recorded and a later refresh fills it", async () => {
    const srv = server(range(1, 200));
    const sync = new ChatSync<M>(srv.f, () => {}, PAGE);
    await sync.refresh();
    expect(sync.current.messages.length).toBe(200);
    expect(sync.current.gap).toBeNull();
    srv.add(range(201, 500));                         // 300 arrive while disconnected
    srv.failNext.newer = 1;                           // the first forward request fails
    await sync.refresh();
    expect(sync.current.messages.length).toBe(400);  // 1..200 + 301..500
    expect(sync.current.gap).toEqual({ created_at: msg(200).created_at, id: "m0200" });
    expect(sync.current.lastError).toBe("catch-up");
    await sync.refresh();                             // plain refresh later: the gap is retried
    expect(sync.current.gap).toBeNull();
    expect(sync.current.messages.length).toBe(500);
    expect(ids(sync.current.messages).slice(199, 202)).toEqual(["m0200", "m0201", "m0202"]);
  });

  it("an overlapping verification that finishes late cannot overwrite a completed catch-up", async () => {
    const srv = server(range(1, 200));
    const sync = new ChatSync<M>(srv.f, () => {}, PAGE);
    await sync.refresh();
    // verification starts and its first request is held until released
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    srv.gates.latest = () => held;
    const verifying = sync.verify();
    srv.gates.latest = undefined;
    srv.add(range(201, 500));
    await sync.refresh();                             // catch-up completes while the verification is still in flight
    expect(sync.current.messages.length).toBe(500);
    release();
    await verifying;                                  // finishes with its older snapshot
    expect(sync.current.messages.length).toBe(500);  // nothing lost
  });

  it("a newest page that arrives out of order is ignored", async () => {
    const srv = server(range(1, 50));
    const sync = new ChatSync<M>(srv.f, () => {}, PAGE);
    let releaseFirst!: () => void;
    const first = new Promise<void>((r) => { releaseFirst = r; });
    srv.gates.latest = () => first;
    const r1 = sync.refresh();                        // sees 1..50 once released
    srv.gates.latest = undefined;
    srv.add([msg(51)]);
    await sync.refresh();                             // second request completes first with 1..51
    expect(sync.current.messages.length).toBe(51);
    releaseFirst();
    await r1;
    expect(sync.current.messages.length).toBe(51);   // the stale page did not remove m0051
  });

  it("deletions are reconciled by verification without resurrecting anything", async () => {
    const srv = server(range(1, 450));
    const sync = new ChatSync<M>(srv.f, () => {}, PAGE);
    await sync.refresh();
    await sync.loadOlder(); await sync.loadOlder();
    expect(sync.current.messages.length).toBe(450);
    expect(sync.current.historyDone).toBe(true);
    srv.remove(["m0010", "m0440"]);                   // one outside the newest page, one inside
    await sync.verify();
    expect(ids(sync.current.messages)).not.toContain("m0010");
    expect(ids(sync.current.messages)).not.toContain("m0440");
    expect(sync.current.messages.length).toBe(448);
  });

  it("a clear drops older history and keeps an in-flight page from bringing it back", async () => {
    const srv = server(range(1, 100));
    const sync = new ChatSync<M>(srv.f, () => {}, PAGE);
    await sync.refresh();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    srv.gates.latest = () => held;
    const inflight = sync.refresh();                  // started before the clear
    srv.gates.latest = undefined;
    const clearedAt = new Date(Date.UTC(2026, 9, 20, 0, 1, 0)).toISOString();   // after msg 59
    sync.setClearedAt(clearedAt);
    expect(sync.current.messages.length).toBe(41);
    release();
    await inflight;                                   // its page is filtered by the clear time
    expect(sync.current.messages.length).toBe(41);
    expect(ids(sync.current.messages)[0]).toBe("m0060");
  });

  it("read-marker input stays bounded to what is loaded after a gap", async () => {
    const srv = server(range(1, 200));
    const sync = new ChatSync<M>(srv.f, () => {}, PAGE);
    await sync.refresh();
    srv.add(range(201, 500));
    srv.failNext.newer = 1;
    await sync.refresh();
    const newest = sync.current.messages[sync.current.messages.length - 1];
    expect(newest.id).toBe("m0500");                 // the newest loaded message, which the read mark is bounded to
  });
});
