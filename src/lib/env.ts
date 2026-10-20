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
  siteUrl: () => process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  adminEmail: () => process.env.ADMIN_EMAIL?.toLowerCase() ?? null,
  cronSecret: () => process.env.CRON_SECRET ?? null,
  aiProvider: () => (process.env.AI_PROVIDER === "anthropic" ? "anthropic" : "mock") as "anthropic" | "mock",
  anthropicApiKey: () => process.env.ANTHROPIC_API_KEY ?? null,
  anthropicModel: () => process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  resendApiKey: () => process.env.RESEND_API_KEY ?? null,
  emailFrom: () => process.env.EMAIL_FROM ?? "Common Ground <noreply@example.com>",
  isProduction: () => process.env.NODE_ENV === "production",
  mockAllowedInProduction: () => process.env.AI_MOCK_ALLOW_IN_PRODUCTION === "true",
};
