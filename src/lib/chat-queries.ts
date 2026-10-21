// The chat's read queries, shared with tests so the exact shape that the
// screen uses is what gets exercised.
import type { SupabaseClient } from "@supabase/supabase-js";
import { PAGE_SIZE, olderFilter } from "@/lib/chat-history";

export const MESSAGE_COLS = "id, sender_participant_id, kind, body, created_at";
export const PENDING_COLS = "id, client_send_id, kind, question_id, body, status, user_explanation, suggested_revision, created_at, attempts";

// Send records that still need the sender (cancel / revise / appeal). Completed
// ones (approved, cancelled) are history and never need to be loaded here, so a
// long chat cannot push a fresh "revise" out of the result.
export const ACTIONABLE_PENDING = ["pending", "review", "revise", "blocked"];

export function latestMessages(sb: SupabaseClient, conversationId: string, pageSize = PAGE_SIZE) {
  return sb.from("approved_messages").select(MESSAGE_COLS).eq("conversation_id", conversationId)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(pageSize);
}

export function olderMessages(sb: SupabaseClient, conversationId: string, cursor: { created_at: string; id: string }, pageSize = PAGE_SIZE) {
  return sb.from("approved_messages").select(MESSAGE_COLS).eq("conversation_id", conversationId).or(olderFilter(cursor))
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(pageSize);
}

export function actionablePending(sb: SupabaseClient, conversationId: string, limit = 50) {
  return sb.from("pending_messages").select(PENDING_COLS).eq("conversation_id", conversationId)
    .in("status", ACTIONABLE_PENDING).order("created_at", { ascending: false }).limit(limit);
}
