import { z } from "zod";

// Fail-closed: `decision` must be one of four values. The other fields are
// advisory and a model may omit them or send null; both are accepted
// deliberately (an omitted or null list is "none", a null confidence is 0.5).
// Anything else (wrong types, out-of-range numbers) still fails validation,
// which keeps the message pending.
export const ModerationDecisionSchema = z.object({
  decision: z.enum(["allow", "revise", "block", "review"]),
  categories: z.array(z.string().max(60)).max(10).nullable().optional().transform((v) => v ?? []),
  user_explanation: z.string().max(600).nullable().optional().transform((v) => v ?? null),
  suggested_revision: z.string().max(2000).nullable().optional().transform((v) => v ?? null),
  confidence: z.number().min(0).max(1).nullable().optional().transform((v) => v ?? 0.5),
});
export type ModerationDecision = z.infer<typeof ModerationDecisionSchema>;

export const GeneratedQuestionSchema = z.object({
  shared_question: z.string().min(10).max(240),
  choices: z.array(z.string().min(2).max(120)).length(3),
  optional_followup_a: z.string().max(240).nullable().optional().transform((v) => v ?? null),
  optional_followup_b: z.string().max(240).nullable().optional().transform((v) => v ?? null),
  rationale_internal: z.string().max(600).nullable().optional().transform((v) => v ?? ""),
  sensitive_topic_flag: z.boolean().nullable().optional().transform((v) => v ?? false),
});
export type GeneratedQuestion = z.infer<typeof GeneratedQuestionSchema>;

export const ConnectionReadinessSchema = z.object({
  eligible_for_invitation: z.boolean(),
  policy_reasons: z.array(z.string().max(200)).max(10).default([]),
  unresolved_flags: z.array(z.string().max(200)).max(10).default([]),
});
export type ConnectionReadiness = z.infer<typeof ConnectionReadinessSchema>;

// Inputs ---------------------------------------------------------------

export type ModerationInput = {
  body: string;
  kind: "chat" | "answer";
  // Recent approved messages in this conversation, oldest first, sender-relative.
  recent: { fromSender: boolean; body: string }[];
  // Hits from deterministic detectors, passed so the model can weigh them.
  detectorHits: string[];
  // Friends tier: both people chose to share contact details in this chat, so
  // identity screening is off (abuse/threat screening stays on).
  contactAllowed?: boolean;
};

export type QuestionInput = {
  phase: "opening" | "mid";
  seq: number;
  // Only present when BOTH participants consented to share coarse context.
  sharedContext: { lifeContext: string[] }[] | null;
  previousQuestions: string[];
  skippedQuestions: string[];
  recent: { alias: string; body: string }[];
};
