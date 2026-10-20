// Curated fallback bank. Used by the mock provider and when the model's output
// fails validation. Ordered gently → deeper.
import type { GeneratedQuestion } from "./schemas";

export const QUESTION_BANK: GeneratedQuestion[] = [
  {
    shared_question: "What's a small thing that reliably makes a hard day a little better?",
    choices: ["Time with someone I love", "Being outside or moving", "Quiet time alone"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Low-stakes opener; everyone has one.", sensitive_topic_flag: false,
  },
  {
    shared_question: "Who do you feel responsible for, and what worries you about their future?",
    choices: ["Family I look after", "People I work with or lead", "Mostly myself right now"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Responsibility is universal and non-political.", sensitive_topic_flag: false,
  },
  {
    shared_question: "Where do you feel most like you belong?",
    choices: ["A place I've known for years", "A group of people, wherever we are", "I'm still looking for it"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Belonging.", sensitive_topic_flag: false,
  },
  {
    shared_question: "When was the last time you felt genuinely misunderstood?",
    choices: ["Recently, by someone close to me", "At work or in public", "It's been a while"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Being misunderstood; invites empathy without positions.", sensitive_topic_flag: false,
  },
  {
    shared_question: "What's something you're uncertain about right now that you don't usually admit?",
    choices: ["Whether I'm on the right path", "Whether things will get better", "What I actually believe about something"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Uncertainty; optional depth.", sensitive_topic_flag: false,
  },
  {
    shared_question: "How has the place you grew up shaped what you worry about today?",
    choices: ["A lot: I still carry it", "Some, but I've changed", "Not much; I've moved on"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Origins without asking for location.", sensitive_topic_flag: false,
  },
  {
    shared_question: "Who taught you the most about how to treat people?",
    choices: ["A parent or grandparent", "A teacher, coach or mentor", "Someone who treated me badly"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Values via people, not positions.", sensitive_topic_flag: false,
  },
  {
    shared_question: "When do you feel loneliest, even around other people?",
    choices: ["When I can't say what I really think", "When everyone else seems sure of themselves", "When I'm the one holding things together"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Loneliness; deeper.", sensitive_topic_flag: false,
  },
  {
    shared_question: "What gives you hope lately, even a little?",
    choices: ["Younger people I know", "Small kindnesses I notice", "Honestly, not much right now"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Hope; allows an honest negative.", sensitive_topic_flag: false,
  },
  {
    shared_question: "What's one thing you wish people on the 'other side' understood about your daily life?",
    choices: ["How hard I work just to get by", "How much I care about the people around me", "That I have doubts too"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Acknowledges difference; stays on lived experience.", sensitive_topic_flag: false,
  },
  {
    shared_question: "What's a change in your life you didn't choose, and how did you get through it?",
    choices: ["Leaning on people", "Keeping busy", "I'm still getting through it"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Mid-chat; change and resilience.", sensitive_topic_flag: true,
  },
  {
    shared_question: "What do you do when you realize you were wrong about something that mattered?",
    choices: ["Say so, even if it's awkward", "Quietly adjust", "Struggle to admit it"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Mid-chat; humility.", sensitive_topic_flag: false,
  },
  {
    shared_question: "Is there someone you've drifted from that you still think about?",
    choices: ["A friend", "A family member", "Not really"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Mid-chat; loss of connection.", sensitive_topic_flag: false,
  },
  {
    shared_question: "What does a good neighbor do, in your experience?",
    choices: ["Shows up when it counts", "Respects your space", "I haven't had many"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Mid-chat; community.", sensitive_topic_flag: false,
  },
  {
    shared_question: "What's something you've had to explain about yourself more times than you'd like?",
    choices: ["My work or how I spend my time", "A choice my family didn't expect", "How I see the world"],
    optional_followup_a: null, optional_followup_b: null,
    rationale_internal: "Mid-chat; being misunderstood.", sensitive_topic_flag: false,
  },
];

export function pickFromBank(previous: string[], skipped: string[]): GeneratedQuestion {
  const used = new Set([...previous, ...skipped]);
  const next = QUESTION_BANK.find((q) => !used.has(q.shared_question));
  return next ?? QUESTION_BANK[previous.length % QUESTION_BANK.length];
}
