// Orchestrates a chat's message cache against the server: newest-page
// refreshes, forward catch-up after a gap, older-history paging, deletion
// verification, and explicit clears. Pure state + injected fetchers, so the
// real sequencing (failed catch-up, overlapping requests) is unit-testable.
//
// Guarantees:
//  * every server page is merged into the CURRENT state (functional updates);
//    a request that finishes late never replaces newer data with its snapshot
//  * a newest page older than the last one applied is ignored (sequence guard)
//  * a gap that could not be filled stays recorded and is retried on the next
//    refresh, so a transient failure never silently loses the middle range
//  * deletion checks only remove ids; they cannot resurrect anything
//  * after a clear, nothing older than the clear time is kept or re-added
import { compareMsgs, gapCursor, mergeMessages, olderCursor, reachedStart, reconcile, rangeOfNewestPage, rangeOfNewerPage, rangeOfOlderPage, withoutIds, PAGE_SIZE, type ChatMsg } from "./chat-history";

export type Cursor = { created_at: string; id: string };
type Result<T> = { data: T | null; error: unknown };
export type Fetchers<T extends ChatMsg> = {
  latest(): Promise<Result<T[]>>;                 // newest first
  newer(cursor: Cursor): Promise<Result<T[]>>;    // oldest first, strictly after the cursor
  older(cursor: Cursor): Promise<Result<T[]>>;    // newest first, strictly before the cursor
  existing(ids: string[]): Promise<Result<{ id: string }[]>>;
};

export type SyncState<T extends ChatMsg> = {
  messages: T[];
  gap: Cursor | null;          // unfinished forward catch-up (retried on the next refresh)
  gapTarget: Cursor | null;    // oldest message of the newest page the gap leads up to
  latestFull: boolean;         // the newest page was full → there may be older history
  historyDone: boolean;        // "show earlier" reached the beginning
  clearedAt: string | null;    // nothing older than this is kept
  lastError: string | null;
};

export class ChatSync<T extends ChatMsg> {
  private state: SyncState<T> = { messages: [], gap: null, gapTarget: null, latestFull: false, historyDone: false, clearedAt: null, lastError: null };
  private seq = 0;             // issued to each newest-page request
  private appliedSeq = 0;      // newest-page request last applied
  private olderBusy = false;
  constructor(private readonly fetchers: Fetchers<T>, private readonly onChange: (s: SyncState<T>) => void, private readonly pageSize = PAGE_SIZE, private readonly maxCatchUpPages = 25) {}

  get current() { return this.state; }

  private set(next: Partial<SyncState<T>>) {
    this.state = { ...this.state, ...next };
    this.onChange(this.state);
  }
  private keep(messages: T[]) {
    const c = this.state.clearedAt;
    return c ? messages.filter((m) => m.created_at >= c) : messages;
  }

  // Newest page + any outstanding or newly detected gap.
  async refresh(): Promise<void> {
    const mySeq = ++this.seq;
    const res = await this.fetchers.latest();
    if (res.error || !res.data) { this.set({ lastError: "refresh" }); return; }
    if (mySeq < this.appliedSeq) return;                      // a newer page already landed
    this.appliedSeq = mySeq;
    const page = this.keep(res.data.slice().sort(compareMsgs));
    const before = this.state.messages;
    // detect a gap against the state as it is NOW (not when the request started)
    let gap = this.state.gap;
    let gapTarget = this.state.gapTarget;
    const fresh = gapCursor(before, page, this.pageSize);
    if (fresh && (!gap || compareMsgs({ ...fresh } as ChatMsg, gap as ChatMsg) < 0)) { gap = fresh; }
    if (fresh || gap) gapTarget = page[0] ? { created_at: page[0].created_at, id: page[0].id } : gapTarget;
    this.set({ messages: reconcile(before, page, rangeOfNewestPage(page)), latestFull: page.length >= this.pageSize, gap, gapTarget, lastError: null });
    if (this.state.gap) await this.catchUp();
  }

  // Forward from the recorded gap until the newest page's range is reached.
  // On failure the gap stays recorded.
  private async catchUp(): Promise<void> {
    for (let i = 0; i < this.maxCatchUpPages && this.state.gap; i++) {
      const cursor = this.state.gap;
      const res = await this.fetchers.newer(cursor);
      if (res.error || !res.data) { this.set({ lastError: "catch-up" }); return; }
      const page = this.keep(res.data.slice().sort(compareMsgs));
      const merged = reconcile(this.state.messages, page, rangeOfNewerPage(page, cursor, this.pageSize));
      const newest = page[page.length - 1];
      const target = this.state.gapTarget;
      const done = page.length < this.pageSize || !newest || (target ? compareMsgs(newest, target as ChatMsg) >= 0 : false);
      this.set({ messages: merged, gap: done ? null : { created_at: newest.created_at, id: newest.id }, gapTarget: done ? null : target, lastError: null });
    }
  }

  async loadOlder(): Promise<boolean> {
    const cursor = olderCursor(this.state.messages);
    if (!cursor || this.olderBusy || this.state.historyDone) return false;
    this.olderBusy = true;
    try {
      const res = await this.fetchers.older(cursor);
      if (res.error || !res.data) { this.set({ lastError: "older" }); return false; }
      const page = this.keep(res.data);
      this.set({ messages: reconcile(this.state.messages, page, rangeOfOlderPage(page, cursor, this.pageSize)), historyDone: reachedStart(res.data.length, this.pageSize) || (page.length < res.data.length), lastError: null });
      return true;
    } finally { this.olderBusy = false; }
  }

  // Re-check that cached history outside the newest page still exists. Only
  // removes ids; applied to the current state whenever it finishes.
  async verify(): Promise<void> {
    const snapshot = this.state.messages;
    if (!snapshot.length) return;
    const res = await this.fetchers.latest();
    if (res.error || !res.data) return;
    const page = this.keep(res.data.slice().sort(compareMsgs));
    const pageOldest = page[0] ?? null;
    const outside = pageOldest ? snapshot.filter((m) => compareMsgs(m, pageOldest) < 0) : [];
    const missing: string[] = [];
    for (let i = 0; i < outside.length; i += 200) {
      const chunk = outside.slice(i, i + 200).map((m) => m.id);
      const r = await this.fetchers.existing(chunk);
      if (r.error || !r.data) return;
      const present = new Set(r.data.map((x) => x.id));
      for (const id of chunk) if (!present.has(id)) missing.push(id);
    }
    // ids proven gone inside the newest page's range: only ids that were already in
    // the SNAPSHOT this verification started from. Anything that arrived after the
    // snapshot (a newer refresh) is not in the page we hold and must not be touched.
    const ids = new Set(page.map((m) => m.id));
    const goneInRange = pageOldest ? snapshot.filter((m) => compareMsgs(m, pageOldest) >= 0 && !ids.has(m.id)).map((m) => m.id) : [];
    const gone = [...missing, ...goneInRange];
    if (gone.length) this.set({ messages: withoutIds(this.state.messages, gone) });
  }

  remove(ids: string[]) { if (ids.length) this.set({ messages: withoutIds(this.state.messages, ids) }); }

  // A clear (ours or the other person's): drop everything from before it and
  // never re-add it from an in-flight request. The mark is the SERVER's clearing
  // timestamp and only ever moves forward, so an older value arriving late (a
  // stale conversation row) cannot reopen the window.
  setClearedAt(ts: string | null) {
    if (!ts) return;
    if (this.state.clearedAt && ts <= this.state.clearedAt) return;
    this.set({ clearedAt: ts, messages: this.state.messages.filter((m) => m.created_at >= ts), gap: null, gapTarget: null, historyDone: false });
  }

  // Merge messages that arrived by another path (e.g. a realtime insert payload).
  add(msgs: T[]) { if (msgs.length) this.set({ messages: mergeMessages(this.state.messages, this.keep(msgs)) }); }
}
