// Direct Postgres access for tests that need DDL (temporary triggers) or
// coordinated concurrent transactions (lock-order checks). Local stack only:
// tests/setup.ts has already refused any non-local Supabase URL.
import { Client } from "pg";

export const PG_URL = process.env.TEST_PG_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export async function pgClient() {
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  return c;
}

export async function withPg<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pgClient();
  try { return await fn(c); } finally { await c.end(); }
}
