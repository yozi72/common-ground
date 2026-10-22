// Server-side model gateway. The only place that talks to a model provider.
// Credentials never leave the server; outputs are validated against strict
// schemas; failures throw so callers keep messages pending (never pass).
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  ModerationDecisionSchema, GeneratedQuestionSchema, ConnectionReadinessSchema,
  type ModerationDecision, type ModerationInput, type GeneratedQuestion, type QuestionInput, type ConnectionReadiness,
} from "./schemas";
import { MODERATION_SYSTEM, QUESTION_SYSTEM, CONNECTION_SYSTEM, wrapUntrusted } from "./prompts";
import { runDetectors, DETECTOR_EXPLANATIONS, hitsAreIdentifying, type DetectorHit } from "./detectors";
import { pickFromBank } from "./questionBank";

export class GatewayError extends Error {
  // retryable: transient (network, 5xx, bad JSON) → keep pending and retry.
  // refusal: the model's safety layer declined to assess → hold for a human instead of retrying.
  // outOfTime: the caller's deadline left no room for a call → the claim should be released, not retried as a failure.
  constructor(message: string, public readonly retryable = true, public readonly refusal = false, public readonly outOfTime = false) { super(message); }
}

export type CallOpts = { deadlineMs?: number };   // wall-clock budget left for this call, including retries
export const MODEL_TIMEOUT_MS = 25_000;
const MIN_CALL_MS = 4_000;

// Per-call timeout and retry count that fit inside what is left of the budget.
export function callBudget(deadlineMs: number | undefined) {
  const left = deadlineMs ?? Number.POSITIVE_INFINITY;
  if (left < MIN_CALL_MS) return null;
  const timeout = Math.min(MODEL_TIMEOUT_MS, Math.max(MIN_CALL_MS - 1000, left - 1500));
  const maxRetries = left >= 2 * timeout + 2000 ? 1 : 0;
  return { timeout, maxRetries };
}

export type ModerationResult = ModerationDecision & {
  provider: "anthropic" | "mock";
  model: string | null;
  detectorHits: DetectorHit[];
  rawValid: boolean;
  latencyMs: number;
};

export type QuestionResult = GeneratedQuestion & { source: "ai" | "bank"; provider: "anthropic" | "mock" };

export function providerInfo() {
  const provider = env.aiProvider();
  const configured = provider === "anthropic" && !!env.anthropicApiKey();
  return { provider, configured, model: provider === "anthropic" ? env.anthropicModel() : null };
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

export async function moderate(input: ModerationInput, opts: CallOpts = {}): Promise<ModerationResult> {
  const started = Date.now();
  // Detectors always run. In a friends-tier chat their hits are hints only (a URL
  // may be a phishing link; the model decides); they are never a floor there.
  const hits: DetectorHit[] = input.detectorHits.length
    ? (input.detectorHits as DetectorHit[])
    : runDetectors(input.body, input.recent.filter((r) => r.fromSender).map((r) => r.body));
  const { provider } = providerInfo();

  if (provider === "mock") {
    return { ...mockModerate(input, hits), provider: "mock", model: null, detectorHits: hits, rawValid: true, latencyMs: Date.now() - started };
  }

  const userPrompt = [
    `Message kind: ${input.kind}`,
    `Contact sharing in this chat: ${input.contactAllowed ? "ALLOWED (both people chose to become friends; names, contact details, employers, platforms and links are fine; still block threats, harassment, dehumanization, sexual content and doxxing of third parties)" : "NOT allowed (apply identity protection)"}`,
    `Detector hits: ${hits.length ? hits.join(", ") : "none"}`,
    wrapUntrusted("recent_context", input.recent.map((r) => `${r.fromSender ? "SENDER" : "OTHER"}: ${r.body}`).join("\n") || "(none)"),
    wrapUntrusted("pending_message", input.body),
  ].join("\n\n");

  const { text: raw, model } = await callAnthropic(MODERATION_SYSTEM, userPrompt, 600, env.moderationModel(), "moderation", opts);
  const parsed = ModerationDecisionSchema.safeParse(extractJson(raw));
  if (!parsed.success) {
    // Invalid model output is a service failure: fail into pending/retry, never allow.
    throw new GatewayError("moderation output failed validation");
  }
  const d = parsed.data;
  // Outside the friends tier, detectors are a floor: an identifying hit can never be silently allowed.
  if (!input.contactAllowed && d.decision === "allow" && hitsAreIdentifying(hits)) {
    return {
      ...d, decision: "revise",
      categories: [...new Set([...d.categories, "identifying_details"])],
      user_explanation: d.user_explanation ?? hits.map((h) => DETECTOR_EXPLANATIONS[h]).join(" "),
      suggested_revision: d.suggested_revision ?? null,
      provider: "anthropic", model, detectorHits: hits, rawValid: true, latencyMs: Date.now() - started,
    };
  }
  return { ...d, provider: "anthropic", model, detectorHits: hits, rawValid: true, latencyMs: Date.now() - started };
}

// The mock never pretends to be a model. It applies the deterministic detectors
// and a tiny abuse list; everything else is allowed in development. In
// production it refuses to allow chat (review) unless explicitly permitted.
function mockModerate(input: ModerationInput, hits: DetectorHit[]): ModerationDecision {
  if (env.isProduction() && !env.mockAllowedInProduction()) {
    return { decision: "review", categories: ["mock_provider"], user_explanation: "Automated review is not configured; this message is held for a human.", suggested_revision: null, confidence: 0 };
  }
  // abuse first: a threat that also contains a phone number is blocked, never softened into a rewording
  if (/\b(kill yourself|i will find you|i'll find you|you people are (?:animals|vermin|subhuman))\b/i.test(input.body)) {
    return { decision: "block", categories: ["threat_or_dehumanization"], user_explanation: "This reads as a threat or dehumanizing language, which can't be delivered. You can say how you feel without directing it at the other person.", suggested_revision: null, confidence: 0.7 };
  }
  if (!input.contactAllowed && hitsAreIdentifying(hits)) {
    return {
      decision: "revise",
      categories: ["identifying_details", ...hits],
      user_explanation: hits.map((h) => DETECTOR_EXPLANATIONS[h]).join(" "),
      suggested_revision: redact(input.body),
      confidence: 0.6,
    };
  }
  if (!input.contactAllowed && hits.includes("platform_mention")) {
    return { decision: "revise", categories: ["platform_mention"], user_explanation: DETECTOR_EXPLANATIONS.platform_mention, suggested_revision: redact(input.body), confidence: 0.5 };
  }
  // The mock has no phishing or doxxing judgement; between friends it allows links and names. Not the production model.
  return { decision: "allow", categories: [], user_explanation: null, suggested_revision: null, confidence: 0.5 };
}

function redact(body: string) {
  return body
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email removed]")
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[number removed]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link removed]")
    .replace(/(^|\s)@[a-z0-9_.]{3,}/gi, "$1[handle removed]")
    .replace(/\b(?:instagram|insta|snapchat|tiktok|twitter|facebook|telegram|signal|whatsapp|discord|linkedin|venmo|cashapp)\b/gi, "[platform]");
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export async function generateQuestion(input: QuestionInput, opts: CallOpts = {}): Promise<QuestionResult> {
  const { provider } = providerInfo();
  if (provider === "mock") {
    return { ...pickFromBank(input.previousQuestions, input.skippedQuestions), source: "bank", provider: "mock" };
  }
  const userPrompt = [
    `Stage: ${input.phase} question #${input.seq}${input.phase === "opening" ? " of the opening round (gentle early, deeper later)" : " (mid-conversation; may reference the recent exchange)"}`,
    input.sharedContext
      ? wrapUntrusted("coarse_context_both_consented", input.sharedContext.map((c, i) => `Person ${i + 1}: ${c.lifeContext.join(", ") || "none"}`).join("\n"))
      : "Coarse context: not shared.",
    wrapUntrusted("previous_questions", input.previousQuestions.join("\n") || "(none)"),
    wrapUntrusted("skipped_questions", input.skippedQuestions.join("\n") || "(none)"),
    wrapUntrusted("recent_conversation", input.recent.map((r) => `${r.alias}: ${r.body}`).join("\n") || "(none yet)"),
  ].join("\n\n");

  try {
    const { text: raw } = await callAnthropic(QUESTION_SYSTEM, userPrompt, 500, env.questionModel(), "questions", opts);
    const parsed = GeneratedQuestionSchema.safeParse(extractJson(raw));
    if (parsed.success && choicesLookSafe(parsed.data.choices) && !input.previousQuestions.includes(parsed.data.shared_question)) {
      return { ...parsed.data, source: "ai", provider: "anthropic" };
    }
  } catch (e) {
    console.warn("[gateway] question generation failed, using bank:", (e as Error).message);
  }
  return { ...pickFromBank(input.previousQuestions, input.skippedQuestions), source: "bank", provider: "anthropic" };
}

// Server-side sanity check on generated choices: reject loaded/political options.
const LOADED = /\b(democrat|republican|liberal|conservative|trump|biden|maga|woke|libtard|snowflake|fascist|socialist|communist|immigrant|abortion|gun)\w*/i;
function choicesLookSafe(choices: string[]) {
  const distinct = new Set(choices.map((c) => c.trim().toLowerCase())).size === 3;
  return distinct && !choices.some((c) => LOADED.test(c));
}

// ---------------------------------------------------------------------------
// Connection readiness (policy check only; never a trust score)
// ---------------------------------------------------------------------------

export async function assessConnectionReadiness(input: {
  policyVersion: string; bothParticipated: boolean; bothConsented: boolean;
  blocked: boolean; openReports: number; conversationEnded: boolean;
}): Promise<ConnectionReadiness> {
  // The deterministic policy is authoritative; a model may only add flags for review.
  const reasons: string[] = [];
  if (!input.conversationEnded) reasons.push("conversation not finished");
  if (!input.bothParticipated) reasons.push("both people must have taken part");
  if (input.blocked) reasons.push("a block exists between these people");
  if (input.openReports > 0) reasons.push("an open report involves this conversation");
  const eligible = reasons.length === 0;
  const base: ConnectionReadiness = { eligible_for_invitation: eligible, policy_reasons: eligible ? [`policy ${input.policyVersion}: mutual opt-in, no time gate`] : reasons, unresolved_flags: [] };
  if (providerInfo().provider === "mock" || !eligible) return base;
  try {
    const { text: raw } = await callAnthropic(CONNECTION_SYSTEM, JSON.stringify(input), 300);
    const parsed = ConnectionReadinessSchema.safeParse(extractJson(raw));
    if (parsed.success) return { ...base, unresolved_flags: parsed.data.unresolved_flags };
  } catch { /* policy result stands */ }
  return base;
}

// ---------------------------------------------------------------------------
// Provider plumbing
// ---------------------------------------------------------------------------

let anthropic: Anthropic | null = null;

// One model call bounded by the caller's remaining budget. Returns the text and
// the model that actually answered (server-side fallback may differ from the one asked for).
async function callAnthropic(system: string, user: string, maxTokens: number, model: string = env.anthropicModel(), task: "moderation" | "questions" = "moderation", opts: CallOpts = {}): Promise<{ text: string; model: string }> {
  const key = env.anthropicApiKey();
  if (!key) throw new GatewayError("ANTHROPIC_API_KEY not configured", false);
  const budget = callBudget(opts.deadlineMs);
  if (!budget) throw new GatewayError("no time left for a model call before the deadline", true, false, true);
  // configurable daily usage limit; exhaustion holds messages (never bypasses moderation)
  const { data: allowed, error: budgetErr } = await supabaseAdmin().rpc("take_model_budget", { p_task: task });
  if (budgetErr) throw new GatewayError(`model budget check failed: ${budgetErr.message}`, true);
  if (allowed === false) throw new GatewayError(`model usage limit reached for ${task} today`, true);
  anthropic ??= new Anthropic({ apiKey: key, maxRetries: 1, timeout: MODEL_TIMEOUT_MS }); // defaults; each call passes its own budget
  try {
    // Thinking is always on for current models; `effort: "low"` keeps these short
    // classification calls fast. Thinking tokens count toward max_tokens, hence the headroom.
    const res = await anthropic.beta.messages.create({
      model,
      max_tokens: Math.max(maxTokens, 4000),
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    }, { timeout: budget.timeout, maxRetries: budget.maxRetries });
    if (res.stop_reason === "refusal") {
      throw new GatewayError(`model declined to assess (${res.stop_details?.category ?? "unspecified"})`, false, true);
    }
    if (res.stop_reason === "max_tokens") throw new GatewayError("model output truncated");
    const text = res.content.find((c) => c.type === "text");
    if (!text || text.type !== "text") throw new GatewayError("empty model response");
    return { text: text.text, model: (res as { model?: string }).model ?? model };
  } catch (e) {
    if (e instanceof GatewayError) throw e;
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.BadRequestError) {
      throw new GatewayError(`anthropic ${e.status}: ${e.message}`, false);
    }
    if (e instanceof Anthropic.APIError) throw new GatewayError(`anthropic ${e.status ?? "network"}: ${e.message}`, true);
    throw new GatewayError(`anthropic: ${(e as Error).message}`, true);
  }
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}
