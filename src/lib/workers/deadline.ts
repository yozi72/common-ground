// A wall-clock budget for one worker run. Hosting kills the function at
// maxDuration; every stage checks remainingMs() before starting more work, so
// unfinished work stays claimable (leases expire) instead of half-done.
// The clock is injectable so tests can move time without sleeping.
export class Deadline {
  private constructor(private readonly endAt: number, private readonly clock: () => number) {}
  static in(ms: number, clock: () => number = Date.now) { return new Deadline(clock() + ms, clock); }
  static none() { return new Deadline(Number.POSITIVE_INFINITY, Date.now); }
  remainingMs() { return Math.max(0, this.endAt - this.clock()); }
  expired(marginMs = 0) { return this.remainingMs() <= marginMs; }
  // A deadline that ends earlier by `reserveMs` (for fair scheduling between stages).
  minus(reserveMs: number) { return new Deadline(Math.max(this.clock(), this.endAt - reserveMs), this.clock); }
  // Abort signal for an external call: the shorter of the call's own timeout and what is left.
  signal(maxMs: number) { return AbortSignal.timeout(Math.max(1, Math.min(maxMs, this.remainingMs()))); }
}

// Run `work` only if time remains, and race it against the remaining budget
// (bounded by `maxMs`). The thunk form matters: the external call is NOT
// started when the deadline has already passed. Rejects with a DeadlineError;
// the underlying work is not cancelled (callers pass `deadline.signal()` or a
// provider timeout to anything that can abort).
export class DeadlineError extends Error { constructor(what: string) { super(`deadline reached during ${what}`); } }
export async function within<T>(deadline: Deadline, what: string, work: () => Promise<T>, maxMs = Number.POSITIVE_INFINITY): Promise<T> {
  const ms = Math.min(maxMs, deadline.remainingMs());
  if (ms <= 0) throw new DeadlineError(what);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineError(what)), ms); });
  try { return await Promise.race([work(), timeout]); } finally { clearTimeout(timer); }
}
