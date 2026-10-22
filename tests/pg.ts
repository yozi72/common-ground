// Direct Postgres access for tests that need DDL (temporary triggers) or
// coordinated concurrent transactions (lock-order checks). LOCAL STACK ONLY.
// The destination is validated with the driver's own connection-string parser
// (pg-connection-string), so every override the driver honours is covered:
// the URL host, the `host` and `hostaddr` query parameters, and the libpq
// environment variables PGHOST / PGHOSTADDR. Error messages name the host
// only, never the credentials. Independent of the Supabase URL check in
// tests/setup.ts. Destructive helpers must never reach a hosted database.
import { Client } from "pg";
import { parse } from "pg-connection-string";

export const LOCAL_PG_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export const DEFAULT_PG_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function nonLocal(host: string | null | undefined): string | null {
  if (!host) return null;
  // the driver accepts comma-separated host lists; every entry must be local
  for (const h of String(host).split(",")) { const t = h.trim(); if (t && !LOCAL_PG_HOSTS.has(t)) return t; }
  return null;
}

// Resolves the destination the driver would actually use and refuses anything non-local.
export function assertLocalPgDestination(url: string | undefined, envObj: NodeJS.ProcessEnv = process.env): string {
  const raw = url ?? envObj.TEST_PG_URL ?? DEFAULT_PG_URL;
  let cfg: ReturnType<typeof parse>;
  try { cfg = parse(raw); } catch { throw new Error("tests refuse the Postgres destination: the connection string could not be parsed"); }
  if (!envObj.VITEST && envObj.NODE_ENV !== "test") throw new Error("tests/pg.ts is for automated tests only");
  const effectiveHost = cfg.host || envObj.PGHOST || "localhost";           // the driver's own precedence: string, then PGHOST, then localhost (an empty host is absent)
  const effectiveAddr = (cfg.hostaddr ? String(cfg.hostaddr) : null) || envObj.PGHOSTADDR || null;
  const badHost = nonLocal(effectiveHost);
  if (badHost) throw new Error(`tests refuse the Postgres destination ${badHost}: local stack only`);
  const badAddr = nonLocal(effectiveAddr);
  if (badAddr) throw new Error(`tests refuse the Postgres destination hostaddr ${badAddr}: local stack only`);
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
