// Matching questionnaire. Five dimensions, each answered -2..2 ("unsure" = 0)
// or skipped. Wording is deliberately about preferences, not labels, and the
// answers are never shown to anyone but the person who gave them.
export const DIMENSIONS = [
  { key: "gov_role", prompt: "When something goes wrong in society, I'd rather see…", low: "Communities and individuals fix it", high: "Government step in to fix it" },
  { key: "tradition", prompt: "When it comes to how we live, I lean toward…", low: "Keeping what has worked", high: "Trying new ways" },
  { key: "immigration", prompt: "On newcomers to the country, I generally feel…", low: "We should be more careful", high: "We should be more welcoming" },
  { key: "economy", prompt: "To help people get ahead economically, I'd prioritize…", low: "Lower taxes and fewer rules", high: "Stronger public programs" },
  { key: "institutions", prompt: "Major national institutions (media, courts, agencies) are…", low: "Mostly not working for people like me", high: "Mostly working, if imperfect" },
] as const;

export type DimensionKey = (typeof DIMENSIONS)[number]["key"];
export type PoliticalAnswers = Partial<Record<DimensionKey, number>>;

export const SCALE = [
  { value: -2, label: "Strongly first" },
  { value: -1, label: "Lean first" },
  { value: 0, label: "Unsure / in between" },
  { value: 1, label: "Lean second" },
  { value: 2, label: "Strongly second" },
];

export const LIFE_CONTEXT_OPTIONS = [
  "parent", "caregiver", "veteran", "small business", "shift work", "student", "retired",
  "faith community", "rural roots", "city life", "moved a lot", "first-generation", "unemployed recently", "health challenges",
];
