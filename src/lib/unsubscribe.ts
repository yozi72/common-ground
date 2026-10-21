// Signed one-click unsubscribe tokens for reminder emails. The token binds
// an account id to an HMAC so a link can't be forged or reused for others.
import { createHmac, timingSafeEqual } from "node:crypto";

function secret() {
  return process.env.REMINDER_UNSUB_SECRET ?? process.env.CRON_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "dev-secret";
}

export function unsubscribeToken(accountId: string, s: string = secret()): string {
  const mac = createHmac("sha256", s).update(`unsub:${accountId}`).digest("base64url");
  return `${accountId}.${mac}`;
}

export function verifyUnsubscribeToken(token: string, s: string = secret()): string | null {
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const accountId = token.slice(0, i), mac = token.slice(i + 1);
  if (!/^[0-9a-f-]{36}$/.test(accountId)) return null;
  const expected = createHmac("sha256", s).update(`unsub:${accountId}`).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return accountId;
}
