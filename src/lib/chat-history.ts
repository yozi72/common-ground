// Pure helpers for the chat timeline: the client keeps every message it has
// seen (newest page refreshed on each poll, older pages on request) and never
// drops one just because it fell out of the newest page. Ordering is by
// (created_at, id) so messages with identical timestamps have a stable order
// and pagination has an unambiguous cursor.

export type ChatMsg = { id: string; created_at: string };

export const PAGE_SIZE = 200;

export function compareMsgs(a: ChatMsg, b: ChatMsg) {
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Union of what we had and what just arrived, deduplicated by id, sorted.
export function mergeMessages<T extends ChatMsg>(existing: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);   // newer copy wins (same id, same content)
  return [...byId.values()].sort(compareMsgs);
}

// Cursor for "everything strictly before the oldest message we have".
export function olderCursor(messages: ChatMsg[]): { created_at: string; id: string } | null {
  if (!messages.length) return null;
  const oldest = messages.reduce((a, b) => (compareMsgs(a, b) <= 0 ? a : b));
  return { created_at: oldest.created_at, id: oldest.id };
}

// PostgREST `or` filter for rows before the cursor in (created_at, id) order.
export function olderFilter(c: { created_at: string; id: string }) {
  return `created_at.lt.${c.created_at},and(created_at.eq.${c.created_at},id.lt.${c.id})`;
}

// Whether a fetched page tells us we reached the beginning of history.
export function reachedStart(pageLength: number, pageSize = PAGE_SIZE) {
  return pageLength < pageSize;
}

// Read-mark decision for a friend thread, after one load: mark only what was
// loaded (successful fetch), only while the tab is visible, only up to the
// newest message shown, and not again for the same bound while a previous
// request is still outstanding or succeeded.
export function readMarkFor(input: { kind: string | undefined; loadFailed: boolean; newest: string | null; visible: boolean; lastSent: string | null }): string | null {
  if (input.kind !== "friend" || input.loadFailed || !input.newest || !input.visible) return null;
  if (input.lastSent === input.newest) return null;
  return input.newest;
}

// After the request: keep the bound only on a 2xx; anything else (network
// error, 5xx) clears it so the next load retries.
export function readMarkAfter(lastSent: string | null, ok: boolean): string | null {
  return ok ? lastSent : null;
}
