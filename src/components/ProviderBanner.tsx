import { providerInfo } from "@/lib/ai/gateway";
import { env } from "@/lib/env";

// Makes the mock unmistakable: nobody should believe a model is reviewing
// messages when it is not.
export function ProviderBanner() {
  const info = providerInfo();
  if (info.provider === "anthropic" && info.configured) return null;
  const text = info.provider === "mock"
    ? "Pilot build: message review uses rule-based checks only (AI_PROVIDER=mock). Questions come from the curated bank."
    : "AI provider selected but ANTHROPIC_API_KEY is missing: messages will stay pending until it is set.";
  if (env.isProduction() && info.provider === "mock" && !env.mockAllowedInProduction()) {
    return <div role="status" className="notice notice-bad text-center rounded-none">Automated review is not configured. Messages are held for human review.</div>;
  }
  return <div role="status" className="notice notice-warn text-center rounded-none">{text}</div>;
}
