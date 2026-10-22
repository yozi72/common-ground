import { describe, it, expect } from "vitest";
import { authorizeCron } from "@/app/api/cron/tick/route";
import { ModerationDecisionSchema, GeneratedQuestionSchema } from "@/lib/ai/schemas";

describe("cron authorization (eighth review)", () => {
  it("a configured secret is required in every environment; without one only development is open", () => {
    const s = "s3cret-value";
    for (const prod of [true, false]) {
      expect(authorizeCron(`Bearer ${s}`, s, prod)).toBe(true);
      expect(authorizeCron(null, s, prod)).toBe(false);                 // missing
      expect(authorizeCron("Bearer wrong", s, prod)).toBe(false);       // wrong
      expect(authorizeCron(`Bearer ${s}x`, s, prod)).toBe(false);       // longer
      expect(authorizeCron(s, s, prod)).toBe(false);                    // not a bearer header
    }
    expect(authorizeCron(null, null, true)).toBe(false);                // production without a secret: closed
    expect(authorizeCron("Bearer anything", null, true)).toBe(false);
    expect(authorizeCron(null, null, false)).toBe(true);                // development without a secret: open
  });
});

describe("model output schemas: deliberate null handling, fail-closed decision", () => {
  it("accepts omitted or null advisory fields", () => {
    expect(ModerationDecisionSchema.parse({ decision: "allow" })).toEqual({ decision: "allow", categories: [], user_explanation: null, suggested_revision: null, confidence: 0.5 });
    expect(ModerationDecisionSchema.parse({ decision: "revise", categories: null, user_explanation: null, suggested_revision: null, confidence: null })).toMatchObject({ decision: "revise", categories: [], confidence: 0.5 });
  });
  it("still rejects a missing or unknown decision and wrong types", () => {
    expect(ModerationDecisionSchema.safeParse({}).success).toBe(false);
    expect(ModerationDecisionSchema.safeParse({ decision: "maybe" }).success).toBe(false);
    expect(ModerationDecisionSchema.safeParse({ decision: "allow", categories: "none" }).success).toBe(false);
    expect(ModerationDecisionSchema.safeParse({ decision: "allow", confidence: 7 }).success).toBe(false);
  });
  it("question output: null follow-ups and flags are fine, the question and three choices are required", () => {
    expect(GeneratedQuestionSchema.parse({ shared_question: "What keeps you going on a hard week?", choices: ["Family", "Routine", "Not sure yet"], optional_followup_a: null, optional_followup_b: null, rationale_internal: null, sensitive_topic_flag: null })).toMatchObject({ sensitive_topic_flag: false, rationale_internal: "" });
    expect(GeneratedQuestionSchema.safeParse({ shared_question: "x", choices: ["a", "b"] }).success).toBe(false);
  });
});
