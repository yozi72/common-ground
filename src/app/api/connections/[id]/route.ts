import { z } from "zod";
import { handle, ok, parseBody, requireUser, fromRpcError } from "@/lib/api";

// Friend threads: open (or get) the one persistent chat for a friendship, or
// end the friendship. No invitations, no session hours.
const Body = z.object({ action: z.enum(["open", "remove"]).default("open") });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const { supabase } = await requireUser();
    const b = req.headers.get("content-type")?.includes("application/json") ? await parseBody(req, Body) : { action: "open" as const };
    if (b.action === "remove") {
      const { error } = await supabase.rpc("remove_friend", { p_connection: id });
      if (error) throw fromRpcError(error);
      return ok();
    }
    const { data, error } = await supabase.rpc("open_friend_thread", { p_connection: id });
    if (error) throw fromRpcError(error);
    return ok({ conversation_id: data });
  });
}
