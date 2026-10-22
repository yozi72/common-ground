// Server-only environment access. Never import from client components.
import "server-only";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

// Thrown by every real email/push sender when live delivery is not allowed in
// this process. It is a hard stop, independent of what credentials are present.
export class LiveDeliveryBlockedError extends Error {
  constructor(what: string) {
    super(`${what} blocked: live delivery is off in this environment (automated test, or ALLOW_LIVE_DELIVERY is not "true" outside production)`);
    this.name = "LiveDeliveryBlockedError";
  }
}

function isAutomatedTest() {
  return !!process.env.VITEST || process.env.NODE_ENV === "test";
}

// Delivery isolation (see NOTES.md, 2026-10-21 incident). Real email and push
// providers may be used only in production, or when a developer opts in with
// ALLOW_LIVE_DELIVERY=true, and never under automated tests. Outside that, the
// credentials in .env.local are treated as absent: emailConfigured()/
// pushConfigured() are false, smtp()/resendApiKey() are null, so workers mark
// sends "skipped" and the settings UI says the channel is not set up here.
function liveDeliveryAllowed() {
  if (isAutomatedTest()) return false;
  return process.env.NODE_ENV === "production" || process.env.ALLOW_LIVE_DELIVERY === "true";
}

export const env = {
  supabaseUrl: () => req("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => req("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: () => req("SUPABASE_SERVICE_ROLE_KEY"),
  // Vercel sets VERCEL_PROJECT_PRODUCTION_URL on every deployment, so the site
  // URL only needs to be configured explicitly on other hosts or custom domains.
  siteUrl: () =>
    process.env.NEXT_PUBLIC_SITE_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000"),
  adminEmail: () => process.env.ADMIN_EMAIL?.toLowerCase() ?? null,
  cronSecret: () => process.env.CRON_SECRET ?? null,
  aiProvider: () => (process.env.AI_PROVIDER === "anthropic" ? "anthropic" : "mock") as "anthropic" | "mock",
  anthropicApiKey: () => process.env.ANTHROPIC_API_KEY ?? null,
  anthropicModel: () => process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
  // Per-task overrides so cost can be tuned without a code change.
  moderationModel: () => process.env.ANTHROPIC_MODEL_MODERATION ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
  questionModel: () => process.env.ANTHROPIC_MODEL_QUESTIONS ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
  isAutomatedTest,
  liveDeliveryAllowed,
  // Hard stop for the real senders; call before touching a provider.
  assertLiveDelivery: (what: string) => { if (!liveDeliveryAllowed()) throw new LiveDeliveryBlockedError(what); },
  resendApiKey: () => (liveDeliveryAllowed() ? process.env.RESEND_API_KEY ?? null : null),
  smtp: () => (liveDeliveryAllowed() && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
    ? { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, senderName: process.env.SMTP_SENDER_NAME ?? "Common Ground" }
    : null),
  pushConfigured: () => liveDeliveryAllowed() && !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  emailConfigured: () => liveDeliveryAllowed() && !!(process.env.RESEND_API_KEY || (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)),
  emailFrom: () => process.env.EMAIL_FROM ?? "Common Ground <noreply@example.com>",
  isProduction: () => process.env.NODE_ENV === "production",
  mockAllowedInProduction: () => process.env.AI_MOCK_ALLOW_IN_PRODUCTION === "true",
};
