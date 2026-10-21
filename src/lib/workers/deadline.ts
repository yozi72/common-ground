// A wall-clock budget for one worker run. Hosting kills the function at
// maxDuration; every stage checks remainingMs() before starting more work, so
// unfinished work stays claimable (leases expire) instead of half-done.
export class Deadline {
  private constructor(private readonly endAt: number) {}
  static in(ms: number) { return new Deadline(Date.now() + ms); }
  static none() { return new Deadline(Number.POSITIVE_INFINITY); }
  remainingMs() { return Math.max(0, this.endAt - Date.now()); }
  expired(marginMs = 0) { return this.remainingMs() <= marginMs; }
  // Abort signal for an external call: the shorter of the call's own timeout and what is left.
  signal(maxMs: number) { return AbortSignal.timeout(Math.max(1, Math.min(maxMs, this.remainingMs()))); }
}
