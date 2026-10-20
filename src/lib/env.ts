// Server-only environment access. Never import from client components.
import "server-only";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
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
  resendApiKey: () => process.env.RESEND_API_KEY ?? null,
  smtp: () => (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
    ? { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, senderName: process.env.SMTP_SENDER_NAME ?? "Common Ground" }
    : null),
  emailConfigured: () => !!(process.env.RESEND_API_KEY || (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)),
  emailFrom: () => process.env.EMAIL_FROM ?? "Common Ground <noreply@example.com>",
  isProduction: () => process.env.NODE_ENV === "production",
  mockAllowedInProduction: () => process.env.AI_MOCK_ALLOW_IN_PRODUCTION === "true",
};
