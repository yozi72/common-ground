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

// --- Gap detection (fifth/sixth review) ------------------------------------
// A refreshed newest page is authoritative only for its own range. If the
// cached set's newest message is older than the page's oldest message, there
// may be messages in between that neither contains: catch up forward from the
// cached newest until the page is reached (or the server has nothing more).
export function gapCursor<T extends ChatMsg>(cached: T[], newestPage: T[], pageSize = PAGE_SIZE): { created_at: string; id: string } | null {
  if (!cached.length || newestPage.length < pageSize) return null;   // a short page covers everything after the cache
  const cachedNewest = cached.reduce((a, b) => (compareMsgs(a, b) >= 0 ? a : b));
  const pageOldest = newestPage.reduce((a, b) => (compareMsgs(a, b) <= 0 ? a : b));
  if (compareMsgs(cachedNewest, pageOldest) >= 0) return null;        // ranges overlap: no gap possible
  return { created_at: cachedNewest.created_at, id: cachedNewest.id };
}

// PostgREST `or` filter for rows strictly after the cursor in (created_at, id) order.
export function newerFilter(c: { created_at: string; id: string }) {
  return `created_at.gt.${c.created_at},and(created_at.eq.${c.created_at},id.gt.${c.id})`;
}

// --- Deletion reconciliation --------------------------------------------------
// A page fetched from the server is complete for the range it covers:
//   newest page   → [oldest in page, +∞)
//   older page    → (oldest in page .. cursor) — the cursor itself is excluded
//   forward page  → (cursor .. newest in page]
// Any cached message inside that range that is not in the page no longer
// exists on the server (deleted, expired by retention) and is dropped. Cached
// messages outside the range are kept: absence from a limited query says
// nothing about them.
export type Range = { from: { created_at: string; id: string } | null; fromInclusive: boolean; to: { created_at: string; id: string } | null; toInclusive: boolean };

export function rangeOfNewestPage(page: ChatMsg[]): Range | null {
  if (!page.length) return { from: null, fromInclusive: true, to: null, toInclusive: true }; // empty newest page: the thread is empty
  const oldest = page.reduce((a, b) => (compareMsgs(a, b) <= 0 ? a : b));
  return { from: oldest, fromInclusive: true, to: null, toInclusive: true };
}
export function rangeOfOlderPage(page: ChatMsg[], cursor: { created_at: string; id: string }, pageSize = PAGE_SIZE): Range {
  const oldest = page.length ? page.reduce((a, b) => (compareMsgs(a, b) <= 0 ? a : b)) : null;
  // a short page means the server has nothing older: the range extends to the beginning
  return { from: page.length < pageSize ? null : oldest, fromInclusive: true, to: cursor, toInclusive: false };
}
export function rangeOfNewerPage(page: ChatMsg[], cursor: { created_at: string; id: string }, pageSize = PAGE_SIZE): Range {
  const newest = page.length ? page.reduce((a, b) => (compareMsgs(a, b) >= 0 ? a : b)) : null;
  return { from: cursor, fromInclusive: false, to: page.length < pageSize ? null : newest, toInclusive: true };
}

export function inRange(m: ChatMsg, r: Range) {
  if (r.from) { const c = compareMsgs(m, r.from); if (c < 0 || (c === 0 && !r.fromInclusive)) return false; }
  if (r.to) { const c = compareMsgs(m, r.to); if (c > 0 || (c === 0 && !r.toInclusive)) return false; }
  return true;
}

// Merge a server page into the cache and drop cached messages the page proves gone.
export function reconcile<T extends ChatMsg>(cached: T[], page: T[], range: Range | null): T[] {
  const ids = new Set(page.map((m) => m.id));
  const kept = range ? cached.filter((m) => ids.has(m.id) || !inRange(m, range)) : cached;
  return mergeMessages(kept, page);
}

// Explicit removal (realtime DELETE, or an id check that came back empty).
export function withoutIds<T extends ChatMsg>(cached: T[], gone: Iterable<string>): T[] {
  const g = new Set(gone);
  return cached.filter((m) => !g.has(m.id));
}
