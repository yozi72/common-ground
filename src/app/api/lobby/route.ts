import { z } from "zod";
import { after } from "next/server";
import { handle, ok, parseBody, requireUser, fromRpcError } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { maybeTick } from "@/lib/workers/tick";
import { getScheduleConfig } from "@/lib/schedule-config";
import { sessionState } from "@/lib/schedule";

// Lobby presence and state. Every call returns the server clock and session
// state so clients can keep a server-synchronised countdown.
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("heartbeat") }),
  z.object({ action: z.literal("ready") }),
  z.object({ action: z.literal("broaden"), level: z.enum(["strict", "relaxed", "any"]) }),
]);

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const b = await parseBody(req, Body);
    if (b.action === "ready") {
      const { error } = await supabase.rpc("confirm_ready");
      if (error) throw fromRpcError(error);
      after(async () => { await supabaseAdmin().rpc("run_matching"); });
    } else if (b.action === "broaden") {
      const { error } = await supabase.rpc("set_broaden", { p_level: b.level });
      if (error) throw fromRpcError(error);
      after(async () => { await supabaseAdmin().rpc("run_matching"); });
    }
    const { data: hb, error } = await supabase.rpc("lobby_heartbeat");
    if (error) throw fromRpcError(error);
    // presence changed → someone may have become matchable; also housekeeping
    after(async () => { await supabaseAdmin().rpc("run_matching"); await maybeTick(); });
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
