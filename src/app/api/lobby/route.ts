import { z } from "zod";
import { after } from "next/server";
import { handle, ok, parseBody, requireUser, fromRpcError } from "@/lib/api";
import { maybeTick } from "@/lib/workers/tick";
import { runMatchingObserved } from "@/lib/workers/matching";
import { getScheduleConfig } from "@/lib/schedule-config";
import { sessionState } from "@/lib/schedule";

// Lobby presence and state. Every call returns the server clock and session
// state so clients can keep a server-synchronised countdown.
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("heartbeat") }),
  z.object({ action: z.literal("ready") }),
  z.object({ action: z.literal("broaden"), level: z.enum(["strict", "relaxed", "any"]) }),
]);

// The opportunistic worker tick runs in after() with its own 25 s budget; the
// function limit is explicit so the hosting default never decides it.
export const maxDuration = 60;

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const b = await parseBody(req, Body);
    if (b.action === "ready") {
      const { error } = await supabase.rpc("confirm_ready");
      if (error) throw fromRpcError(error);
      after(async () => { await runMatchingObserved("lobby:ready"); });
    } else if (b.action === "broaden") {
      const { error } = await supabase.rpc("set_broaden", { p_level: b.level });
      if (error) throw fromRpcError(error);
      after(async () => { await runMatchingObserved("lobby:broaden"); });
    }
    const { data: hb, error } = await supabase.rpc("lobby_heartbeat");
    if (error) throw fromRpcError(error);
    // Presence changed → someone may have become matchable. Matching is global and
    // runs every minute from the scheduler anyway; heartbeats only trigger it when
    // the last run ANYWHERE (database-held timestamp, shared across instances) is
    // more than 10 s old: fast enough for a 60 s invitation window, without a full
    // matching pass per 5 s heartbeat.
    after(async () => { await runMatchingObserved("lobby:heartbeat", { minIntervalSeconds: 10 }); await maybeTick(); });
    const cfg = await getScheduleConfig();
    const now = Date.now();
    return ok({ now, session: sessionState(now, cfg), schedule: cfg, request: (hb as { request: unknown })?.request ?? null });
  });
}

export async function GET() {
  return handle(async () => {
    const cfg = await getScheduleConfig();
    const now = Date.now();
    return ok({ now, session: sessionState(now, cfg), schedule: cfg });
  });
}
