import { z } from "zod";
import { after } from "next/server";
import { handle, ok, parseBody, requireUser, fromRpcError } from "@/lib/api";
import { advanceAfterReveal } from "@/lib/workers/moderation";

const Body = z.object({
  action: z.enum(["choice", "skip"]),
  choice: z.number().int().min(0).max(2).optional(),
  conversation_id: z.string().uuid(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const { supabase } = await requireUser();
    const b = await parseBody(req, Body);
    const { data, error } = b.action === "choice"
      ? await supabase.rpc("answer_with_choice", { p_question: id, p_choice: b.choice ?? 0 })
      : await supabase.rpc("skip_question", { p_question: id });
    if (error) throw fromRpcError(error);
    const r = data as { revealed: boolean };
    if (r.revealed) {
      const convId = b.conversation_id;
      after(async () => { try { await advanceAfterReveal(convId); } catch (e) { console.warn("[question] advance", (e as Error).message); } });
    }
    return ok(r);
  });
}
