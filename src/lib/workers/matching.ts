// Best-effort matching runs triggered by user actions (join, ready, broaden,
// heartbeat). The scheduler's minute tick runs matching unconditionally; these
// runs only shorten the wait. A failure here must be visible to operators
// (console + metric event), never silently swallowed, and never reported to
// the user as a successful pairing (the response only confirms their own action).
import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function runMatchingObserved(source: string, opts: { minIntervalSeconds?: number } = {}): Promise<{ pairs: number | null; error: string | null }> {
  const admin = supabaseAdmin();
  const call = opts.minIntervalSeconds
    ? admin.rpc("run_matching_if_due", { p_min_seconds: opts.minIntervalSeconds })   // shared throttle (database), not per instance
    : admin.rpc("run_matching");
  const { data, error } = await call;
  if (error) {
    console.error(`[matching] ${source} failed: ${error.message}`);
    await admin.from("metric_events").insert({ kind: "matching_failed", meta: { source, error: error.message.slice(0, 300) } }).then(() => undefined, () => undefined);
    return { pairs: null, error: error.message };
  }
  return { pairs: (data as number | null) ?? null, error: null };
}
