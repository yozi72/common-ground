// Vitest setup (vitest.config.ts → setupFiles). Runs before every test file.
//
// Delivery isolation: automated tests must never send real email or push, and
// must never run against anything but the local Supabase stack. This file is
// the harness half of that guarantee; src/lib/env.ts is the code half
// (liveDeliveryAllowed() is false whenever VITEST is set). Both are checked by
// tests/email-isolation.test.ts.
//
// 1. Refuse a non-local database (a hosted project would get real test users
//    and could email them).
// 2. Strip every provider credential from the process, whatever .env.local
//    holds (tests are usually run with `.env.local` sourced).
// 3. Replace nodemailer and web-push with fakes that record and throw.
// 4. Block fetch() to any non-local host, so Resend (and anything else
//    external) is unreachable even from code that bypasses the fakes.
import { vi } from "vitest";

export const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"]);

export function assertLocalDatabase(url: string | undefined) {
  let host: string;
  try { host = new URL(url ?? "").hostname; } catch { throw new Error(`tests refuse to start: NEXT_PUBLIC_SUPABASE_URL is not a URL (${url ?? "unset"})`); }
  if (!LOCAL_HOSTS.has(host)) throw new Error(`tests refuse to start: NEXT_PUBLIC_SUPABASE_URL points at ${host}, not the local Supabase stack`);
}

export const PROVIDER_VARS = [
  "RESEND_API_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_PORT", "SMTP_SENDER_NAME",
  "VAPID_PRIVATE_KEY", "NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_SUBJECT",
  "ANTHROPIC_API_KEY", "ALLOW_LIVE_DELIVERY",
] as const;

export type ProviderAttempt = { kind: "smtp" | "push" | "fetch"; detail: string };
declare global {
  var __providerAttempts: ProviderAttempt[] | undefined;
}
export const providerAttempts = (): ProviderAttempt[] => (globalThis.__providerAttempts ??= []);

export function stripProviderCredentials(envObj: NodeJS.ProcessEnv = process.env) {
  for (const k of PROVIDER_VARS) delete envObj[k];
  envObj.AI_PROVIDER = "mock";
}

export function installFetchGuard() {
  const real = globalThis.fetch;
  const guarded = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let host = "";
    try { host = new URL(raw).hostname; } catch { /* relative or invalid: let the real fetch decide */ }
    if (host && !LOCAL_HOSTS.has(host)) {
      providerAttempts().push({ kind: "fetch", detail: host });
      return Promise.reject(new Error(`blocked: automated tests may not reach ${host}`));
    }
    return real(input, init);
  }) as typeof fetch;
  globalThis.fetch = guarded;
  return guarded;
}

assertLocalDatabase(process.env.NEXT_PUBLIC_SUPABASE_URL);
stripProviderCredentials();
installFetchGuard();

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (msg: { to?: string }) => {
        providerAttempts().push({ kind: "smtp", detail: String(msg?.to ?? "") });
        throw new Error("blocked: automated tests cannot send email (fake nodemailer)");
      },
    }),
  },
}));

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: () => undefined,
    sendNotification: async (sub: { endpoint?: string }) => {
      providerAttempts().push({ kind: "push", detail: String(sub?.endpoint ?? "") });
      throw new Error("blocked: automated tests cannot send push (fake web-push)");
    },
  },
}));
