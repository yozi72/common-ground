// Direct Postgres access for tests that need DDL (temporary triggers) or
// coordinated concurrent transactions (lock-order checks). LOCAL STACK ONLY:
// the destination is validated before a client is constructed, independently
// of the Supabase URL check in tests/setup.ts, because TEST_PG_URL (and the
// libpq-style PGHOST / PGHOSTADDR overrides the driver honours) could point
// elsewhere. Destructive helpers must never reach a hosted database.
import { Client } from "pg";

export const LOCAL_PG_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export const DEFAULT_PG_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Resolves the host the driver would actually connect to and refuses anything non-local.
export function assertLocalPgDestination(url: string | undefined, envObj: NodeJS.ProcessEnv = process.env): string {
  const raw = url ?? envObj.TEST_PG_URL ?? DEFAULT_PG_URL;
  let host: string;
  try { host = new URL(raw).hostname; } catch { throw new Error(`tests refuse the Postgres destination: not a URL (${raw})`); }
  if (!LOCAL_PG_HOSTS.has(host)) throw new Error(`tests refuse the Postgres destination ${host}: local stack only`);
  for (const k of ["PGHOST", "PGHOSTADDR"] as const) {
    const v = envObj[k];
    if (v && !LOCAL_PG_HOSTS.has(v)) throw new Error(`tests refuse the Postgres destination from ${k}=${v}: local stack only`);
  }
  if (!envObj.VITEST && envObj.NODE_ENV !== "test") throw new Error("tests/pg.ts is for automated tests only");
  return raw;
}

export const PG_URL = assertLocalPgDestination(undefined);

export async function pgClient(url: string = PG_URL) {
  const c = new Client({ connectionString: assertLocalPgDestination(url) });
  await c.connect();
  return c;
}

export async function withPg<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pgClient();
  try { return await fn(c); } finally { await c.end(); }
}
