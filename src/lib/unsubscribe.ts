// Signed unsubscribe tokens for reminder emails. The token binds an account id
// to an HMAC under a dedicated secret so a link can't be forged or reused for
// others. REMINDER_UNSUB_SECRET is required in production (no fallback to other
// secrets); REMINDER_UNSUB_SECRET_PREVIOUS lets links signed before a rotation
// keep working until it is removed.
import { createHmac, timingSafeEqual } from "node:crypto";

function secrets(): string[] {
  const cur = process.env.REMINDER_UNSUB_SECRET;
  if (!cur) {
    if (process.env.NODE_ENV === "production") throw new Error("REMINDER_UNSUB_SECRET is not set");
    return ["dev-only-unsubscribe-secret"];
  }
  const prev = process.env.REMINDER_UNSUB_SECRET_PREVIOUS;
  return prev ? [cur, prev] : [cur];
}

function sign(accountId: string, s: string) {
  return createHmac("sha256", s).update(`unsub:${accountId}`).digest("base64url");
}

export function unsubscribeToken(accountId: string, s: string = secrets()[0]): string {
  return `${accountId}.${sign(accountId, s)}`;
}

export function verifyUnsubscribeToken(token: string, s?: string): string | null {
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const accountId = token.slice(0, i), mac = token.slice(i + 1);
  if (!/^[0-9a-f-]{36}$/.test(accountId)) return null;
  const a = Buffer.from(mac);
  for (const candidate of s ? [s] : secrets()) {
    const b = Buffer.from(sign(accountId, candidate));
    if (a.length === b.length && timingSafeEqual(a, b)) return accountId;
  }
  return null;
}

// Constant-time comparison for bearer secrets; safe with missing values and unequal lengths.
export function secretsEqual(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (a.length !== b.length) { timingSafeEqual(a, a); return false; }
  return timingSafeEqual(a, b);
}
