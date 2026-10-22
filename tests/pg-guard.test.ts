// The direct Postgres helper refuses any non-local destination before a client
// exists, using the driver's own connection-string parser; `pg` is intercepted
// here so no connection is ever attempted.
import { describe, it, expect, vi } from "vitest";

const constructed: string[] = [];
vi.mock("pg", () => ({
  Client: class { constructor(public opts: { connectionString: string }) { constructed.push(opts.connectionString); } async connect() { throw new Error("intercepted: must not connect"); } async end() { /* noop */ } async query() { return { rows: [] }; } },
}));
const { assertLocalPgDestination, pgClient, DEFAULT_PG_URL } = await import("./pg");
const T = { VITEST: "1" } as unknown as NodeJS.ProcessEnv;

describe("direct Postgres access is local-only in automated tests", () => {
  it("accepts ordinary local URLs", () => {
    expect(assertLocalPgDestination(undefined, T)).toBe(DEFAULT_PG_URL);
    expect(assertLocalPgDestination("postgresql://postgres:x@localhost:54322/postgres", T)).toContain("localhost");
    expect(assertLocalPgDestination("postgresql://postgres:x@127.0.0.1:54322/postgres?host=127.0.0.1", T)).toBeTruthy();
    expect(assertLocalPgDestination("postgresql://postgres:x@localhost/db?hostaddr=127.0.0.1", T)).toBeTruthy();
  });
  it("refuses remote URL hosts, query-string host/hostaddr overrides and host lists", () => {
    expect(() => assertLocalPgDestination("postgresql://postgres:x@db.example.supabase.co:5432/postgres", T)).toThrow(/local stack only/);
    expect(() => assertLocalPgDestination("postgresql://test@127.0.0.1:54322/test?host=remote.example.invalid", T)).toThrow(/remote\.example\.invalid/);   // the reviewer's bypass
    expect(() => assertLocalPgDestination("postgresql://test@127.0.0.1:54322/test?hostaddr=203.0.113.9", T)).toThrow(/hostaddr 203\.0\.113\.9/);
    expect(() => assertLocalPgDestination("postgresql://test@127.0.0.1,db.example.com:54322/test", T)).toThrow(/db\.example\.com/);
    expect(() => assertLocalPgDestination(undefined, { ...T, TEST_PG_URL: "postgresql://u:p@10.0.0.5/db" })).toThrow(/10\.0\.0\.5/);
  });
  it("refuses libpq environment overrides, a bad string and non-test processes, without leaking credentials", () => {
    expect(() => assertLocalPgDestination("postgresql://u:secret@/db", { ...T, PGHOST: "db.example.com" })).toThrow(/db\.example\.com/);
    expect(() => assertLocalPgDestination(undefined, { ...T, PGHOSTADDR: "203.0.113.9" })).toThrow(/hostaddr 203\.0\.113\.9/);
    try { assertLocalPgDestination("postgresql://user:topsecret@db.example.com/db", T); } catch (e) { expect((e as Error).message).not.toContain("topsecret"); expect((e as Error).message).not.toContain("user:"); }
    expect(() => assertLocalPgDestination(undefined, {} as unknown as NodeJS.ProcessEnv)).toThrow(/automated tests only/);
  });
  it("pgClient refuses a remote destination without constructing or connecting a client", async () => {
    await expect(pgClient("postgresql://test@127.0.0.1:54322/test?host=remote.example.invalid")).rejects.toThrow(/local stack only/);
    expect(constructed).toEqual([]);
  });
});
