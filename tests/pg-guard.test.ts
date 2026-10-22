// Item 8: the direct Postgres helper refuses any non-local destination before a
// client exists; `pg` is intercepted here so no connection is ever attempted.
import { describe, it, expect, vi } from "vitest";

const connectCalls: string[] = [];
vi.mock("pg", () => ({
  Client: class { constructor(public opts: { connectionString: string }) { connectCalls.push(opts.connectionString); } async connect() { throw new Error("intercepted: must not connect"); } async end() { /* noop */ } async query() { return { rows: [] }; } },
}));
const { assertLocalPgDestination, pgClient, DEFAULT_PG_URL } = await import("./pg");

describe("direct Postgres access is local-only in automated tests", () => {
  const testEnv = { VITEST: "1" } as NodeJS.ProcessEnv;
  it("accepts the local stack and refuses hosted hosts, PGHOST overrides, bad URLs and non-test processes", () => {
    expect(assertLocalPgDestination(undefined, testEnv)).toBe(DEFAULT_PG_URL);
    expect(assertLocalPgDestination("postgresql://postgres:x@localhost:54322/postgres", testEnv)).toContain("localhost");
    expect(() => assertLocalPgDestination("postgresql://postgres:x@db.example.supabase.co:5432/postgres", testEnv)).toThrow(/local stack only/);
    expect(() => assertLocalPgDestination(undefined, { ...testEnv, TEST_PG_URL: "postgresql://u:p@10.0.0.5/db" })).toThrow(/local stack only/);
    expect(() => assertLocalPgDestination(undefined, { ...testEnv, PGHOST: "db.example.com" })).toThrow(/PGHOST/);
    expect(() => assertLocalPgDestination(undefined, { ...testEnv, PGHOSTADDR: "203.0.113.9" })).toThrow(/PGHOSTADDR/);
    expect(() => assertLocalPgDestination("not a url", testEnv)).toThrow(/not a URL/);
    expect(() => assertLocalPgDestination(undefined, {} as NodeJS.ProcessEnv)).toThrow(/automated tests only/);
  });
  it("pgClient refuses a remote URL without constructing or connecting a client", async () => {
    await expect(pgClient("postgresql://postgres:x@db.example.supabase.co:5432/postgres")).rejects.toThrow(/local stack only/);
    expect(connectCalls).toEqual([]);
  });
});
