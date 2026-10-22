// Matching questionnaire, version 2. Eight specific policy questions with
// ordered, labelled answers. This is an initial product questionnaire and an
// ordinal matching heuristic, not a validated political assessment: it never
// produces a party label, a vote prediction, or a certainty estimate.
//
// Storage (profiles):
//   political_answers      jsonb {key: number}   normalized 0..1, substantive answers only
//   political_nonanswers   jsonb {key: 'unsure' | 'declined'}
//   (untouched questions appear in neither)
//   issue_priorities       text[] up to two keys, collected for evaluation only
//   questionnaire_version  int = 2

export const QUESTIONNAIRE_VERSION = 2;

export type Question = { key: string; topic: string; prompt: string; options: readonly string[] };

export const QUESTIONS: readonly Question[] = [
  { key: "public_services", topic: "Public services", prompt: "Should government spending on public services increase or decrease?",
    options: ["Decrease substantially", "Decrease somewhat", "Stay about the same", "Increase somewhat", "Increase substantially"] },
  { key: "high_income_taxes", topic: "Higher-income taxes", prompt: "Should federal income taxes on high-income households increase or decrease?",
    options: ["Decrease substantially", "Decrease somewhat", "Stay about the same", "Increase somewhat", "Increase substantially"] },
  { key: "healthcare", topic: "Healthcare", prompt: "How much responsibility should the federal government have for ensuring everyone has health coverage?",
    options: ["None", "A little", "Some", "A lot", "Full responsibility"] },
  { key: "legal_immigration", topic: "Legal immigration", prompt: "Should the number of people allowed to immigrate legally to the U.S. each year increase or decrease?",
    options: ["Decrease substantially", "Decrease somewhat", "Stay about the same", "Increase somewhat", "Increase substantially"] },
  { key: "deportations", topic: "Immigration enforcement", prompt: "Do you support or oppose expanding deportations of people living in the U.S. without legal authorization?",
    options: ["Strongly oppose", "Somewhat oppose", "Neither support nor oppose", "Somewhat support", "Strongly support"] },
  { key: "abortion", topic: "Abortion", prompt: "In which circumstances should abortion be legal?",
    options: ["Legal in all circumstances", "Legal in most circumstances", "Legal in few circumstances", "Legal in no circumstances"] },
  { key: "gun_purchases", topic: "Gun purchases", prompt: "Should laws governing gun purchases become stricter or less strict?",
    options: ["Much less strict", "Somewhat less strict", "Stay about the same", "Somewhat stricter", "Much stricter"] },
  { key: "climate", topic: "Climate policy", prompt: "Do you support or oppose stricter federal limits on greenhouse-gas emissions?",
    options: ["Strongly oppose", "Somewhat oppose", "Neither support nor oppose", "Somewhat support", "Strongly support"] },
] as const;

export const UNSURE_LABEL = "Not sure / haven't formed an opinion";
export const DECLINE_LABEL = "Prefer not to answer";

export type NonAnswer = "unsure" | "declined";
export type Answers = Record<string, number>;          // key -> normalized 0..1
export type NonAnswers = Record<string, NonAnswer>;

// Thresholds (provisional, configurable in policy_config; see HANDOFF.md).
export const MIN_SHARED_ANSWERS = 5;
export const DEFAULT_DIFFERENT_THRESHOLD = 0.4;  // "different views" (strict)
export const DEFAULT_RELAXED_THRESHOLD = 0.2;    // after consent to a smaller difference

export function questionByKey(key: string) { return QUESTIONS.find((q) => q.key === key); }

// Ordered option index -> 0..1. A 4-option question maps to 0, 1/3, 2/3, 1;
// a 5-option one to 0, .25, .5, .75, 1. An explicit middle option is a
// substantive answer (0.5), unlike "not sure".
export function normalize(key: string, optionIndex: number): number {
  const q = questionByKey(key);
  if (!q) throw new Error(`unknown question ${key}`);
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= q.options.length) throw new Error(`bad option ${optionIndex} for ${key}`);
  return q.options.length === 1 ? 0 : optionIndex / (q.options.length - 1);
}

export function optionIndexFromValue(key: string, value: number): number {
  const q = questionByKey(key)!;
  return Math.round(value * (q.options.length - 1));
}

export type Comparison =
  | { status: "insufficient"; shared: number }
  | { status: "ok"; shared: number; score: number; perIssue: Record<string, number> };

// Mean absolute distance over shared substantive answers; symmetric; equal weight per question.
export function compareProfiles(a: Answers, b: Answers, aVersion = QUESTIONNAIRE_VERSION, bVersion = QUESTIONNAIRE_VERSION, minShared = MIN_SHARED_ANSWERS): Comparison {
  if (aVersion !== bVersion) return { status: "insufficient", shared: 0 };
  const perIssue: Record<string, number> = {};
  for (const q of QUESTIONS) {
    const x = a[q.key], y = b[q.key];
    if (typeof x === "number" && typeof y === "number") perIssue[q.key] = Math.abs(x - y);
  }
  const keys = Object.keys(perIssue);
  if (keys.length < minShared) return { status: "insufficient", shared: keys.length };
  const score = keys.reduce((s, k) => s + perIssue[k], 0) / keys.length;
  return { status: "ok", shared: keys.length, score: Math.round(score * 1000) / 1000, perIssue };
}

export function answeredCount(a: Answers) { return QUESTIONS.filter((q) => typeof a[q.key] === "number").length; }

// Server contract (complete_onboarding): at most this many tags, each from the list below.
export const MAX_LIFE_CONTEXT = 6;
export const LIFE_CONTEXT_OPTIONS = [
  "parent", "caregiver", "veteran", "small business", "shift work", "student", "retired",
  "faith community", "rural roots", "city life", "moved a lot", "first-generation", "unemployed recently", "health challenges",
];
