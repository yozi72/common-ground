// Pure helpers over my_recent_conversations rows, shared by the lobby nudge,
// the Chats list and the reflection page (and their tests).
//
// both_yes: both people decided "keep talking" in THIS conversation (unrevoked).
// connected: an active chat with this person exists, from this or an earlier
// conversation. A rematch with someone you already chat with is therefore
// connected && !both_yes: there is nothing to decide, and the server refuses a
// "no" while the chat is active, so the UI must offer the existing chat instead.
export type RecentRow = { conversation_id: string; peer_alias: string; my_decision: boolean | null; both_yes: boolean; connected: boolean; connection_id: string | null; thread_id: string | null; reflection_done?: boolean };

export function undecidedRecent<T extends RecentRow>(rows: T[]): { conversation_id: string; peer_alias: string }[] {
  return rows.filter((r) => r.my_decision === null && !r.both_yes && !r.connected).map((r) => ({ conversation_id: r.conversation_id, peer_alias: r.peer_alias }));
}

// What the reflection page shows for the keep-talking card.
export type ReflectConnection = { connectionId: string; threadId: string | null; fromThisConversation: boolean };
export function reflectConnection(row: RecentRow | undefined): ReflectConnection | null {
  if (!row || !row.connection_id || !row.connected) return null;
  return { connectionId: row.connection_id, threadId: row.thread_id, fromThisConversation: row.both_yes };
}
