import { z } from "zod";
import { after } from "next/server";
import { handle, ok, parseBody, requireUser, fromRpcError } from "@/lib/api";
import { generateNextQuestion } from "@/lib/workers/questions";

const Body = z.object({ accept: z.boolean() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const { supabase } = await requireUser();
    const body = await parseBody(req, Body);
    const { data, error } = await supabase.rpc("respond_invitation", { p_invitation: id, p_accept: body.accept });
    if (error) throw fromRpcError(error);
    const result = data as { status: string; conversation_id?: string };
    if (result.status === "opened" && result.conversation_id) {
      const convId = result.conversation_id;
      after(async () => {
        try { await generateNextQuestion(convId, "opening", { deadlineMs: 40_000 }); } catch (e) { console.warn("[invitation] first question", (e as Error).message); }
      });
    }
    return ok(result);
  });
}
