import { z } from "zod";
import { after } from "next/server";
import { handle, ok, parseBody, requireUser, fromRpcError } from "@/lib/api";
import { maybeTick } from "@/lib/workers/tick";
import { runMatchingObserved } from "@/lib/workers/matching";

const Body = z.object({ action: z.enum(["join", "leave"]), notify_email: z.boolean().optional() });

// The opportunistic worker tick runs in after() with its own 25 s budget; the
// function limit is explicit so the hosting default never decides it.
export const maxDuration = 60;

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const body = await parseBody(req, Body);
    if (body.action === "join") {
      const { data, error } = await supabase.rpc("join_queue", { p_notify_email: body.notify_email ?? false });
      if (error) throw fromRpcError(error);
      // try to pair immediately rather than waiting for the next tick; a failure is logged and
      // recorded (metric event), the response only confirms that the queue entry exists
      after(async () => { await runMatchingObserved("queue:join"); await maybeTick(); });
      return ok({ request_id: data });
    }
    const { error } = await supabase.rpc("leave_queue");
    if (error) throw fromRpcError(error);
    return ok();
  });
}
