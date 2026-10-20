// Question generation. Builds the minimal context the gateway needs: coarse
// life-context only when BOTH participants consented, previous and skipped
// questions, and the last few approved messages (by alias).
import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { generateQuestion } from "@/lib/ai/gateway";

export async function generateNextQuestion(conversationId: string, phase: "opening" | "mid") {
  const admin = supabaseAdmin();

  const [{ data: conv }, { data: questions }, { data: participants }, { data: aliases }, { data: recentRows }] = await Promise.all([
    admin.from("conversations").select("status, questions_asked").eq("id", conversationId).single(),
    admin.from("conversation_questions").select("id, question_text, status, revealed_at").eq("conversation_id", conversationId).order("seq"),
    admin.from("participants").select("id, account_id").eq("conversation_id", conversationId),
    admin.from("participant_aliases").select("participant_id, alias").eq("conversation_id", conversationId),
    admin.from("approved_messages").select("sender_participant_id, body").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(10),
  ]);
  if (!conv || conv.status === "ended") return null;
  if (questions?.some((q) => q.status === "open")) return null; // one at a time

  const previous = (questions ?? []).map((q) => q.question_text);
  // skipped = questions where someone skipped
  const { data: skips } = await admin.from("question_answers").select("question_id").eq("conversation_id", conversationId).eq("status", "skipped");
  const skippedIds = new Set((skips ?? []).map((s) => s.question_id));
  const skipped = (questions ?? []).filter((q) => skippedIds.has(q.id)).map((q) => q.question_text);

  const aliasOf = new Map((aliases ?? []).map((a) => [a.participant_id, a.alias]));
  const accountIds = (participants ?? []).map((p) => p.account_id);
  const { data: profiles } = await admin.from("profiles").select("life_context, share_context_with_prompts").in("account_id", accountIds);
  const bothConsented = (profiles?.length ?? 0) === 2 && profiles!.every((p) => p.share_context_with_prompts);
  const sharedContext = bothConsented ? profiles!.map((p) => ({ lifeContext: p.life_context ?? [] })) : null;

  const recent = (recentRows ?? []).reverse().map((m) => ({ alias: aliasOf.get(m.sender_participant_id) ?? "Someone", body: m.body }));

  const q = await generateQuestion({ phase, seq: (conv.questions_asked ?? 0) + 1, sharedContext, previousQuestions: previous, skippedQuestions: skipped, recent });

  const { data: id, error } = await admin.rpc("insert_question", {
    p_conversation: conversationId,
    p_phase: phase,
    p_text: q.shared_question,
    p_choices: q.choices,
    p_followup_a: q.optional_followup_a,
    p_followup_b: q.optional_followup_b,
    p_source: q.source,
    p_sensitive: q.sensitive_topic_flag,
    p_rationale: q.rationale_internal,
  });
  if (error) throw new Error(`insert_question: ${error.message}`);
  return id as string;
}
