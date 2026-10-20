import { z } from "zod";
import { after } from "next/server";
import { handle, ok, parseBody, requireUser, fromRpcError } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/admin";

const Body = z.object({ action: z.enum(["join", "leave"]), notify_email: z.boolean().optional() });

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const body = await parseBody(req, Body);
    if (body.action === "join") {
      const { data, error } = await supabase.rpc("join_queue", { p_notify_email: body.notify_email ?? false });
      if (error) throw fromRpcError(error);
      // try to pair immediately rather than waiting for the next tick
      after(async () => { await supabaseAdmin().rpc("run_matching"); });
      return ok({ request_id: data });
    }
    const { error } = await supabase.rpc("leave_queue");
    if (error) throw fromRpcError(error);
    return ok();
  });
}
