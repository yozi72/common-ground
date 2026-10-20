import { handle, ok, requireUser, fromRpcError } from "@/lib/api";

// Ask to talk again with a mutual connection. Creates a reconnect invitation
// that the other person must accept; nothing else changes.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const { supabase } = await requireUser();
    const { data, error } = await supabase.rpc("request_reconnection", { p_connection: id });
    if (error) throw fromRpcError(error);
    return ok({ invitation_id: data });
  });
}
