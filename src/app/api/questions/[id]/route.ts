import { z } from "zod";
import { after } from "next/server";
import { handle, ok, parseBody, requireUser, fromRpcError, ApiError } from "@/lib/api";
import { advanceAfterReveal } from "@/lib/workers/moderation";
import { Deadline } from "@/lib/workers/deadline";

// Answer or skip a shared question. The RPC authorizes the question itself
// (participant, open, not left, not blocked). The conversation that follow-up
// generation works on is derived from the authorized question under RLS,
// never from the request body: a client cannot point privileged work at
// another conversation.
const Body = z.object({
  action: z.enum(["choice", "skip"]),
  choice: z.number().int().min(0).max(2).optional(),
  conversation_id: z.string().uuid().optional(),   // accepted for older clients, ignored
});

// Hosting: every model-calling route exports maxDuration = 60 and establishes
// ONE deadline at entry (ROUTE_BUDGET_MS = 45 s) that covers auth, database
// work, the model call with its retries and any follow-up generation; what
// cannot finish in time is left recoverable (claims are released, the tick
// retries, questions fall back to the bank).
export const maxDuration = 60;
const ROUTE_BUDGET_MS = 45_000;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const deadline = Deadline.in(ROUTE_BUDGET_MS);   // one budget from request entry; the follow-up runs inside it after the response
    const { id } = await ctx.params;
    const { supabase } = await requireUser();
    const b = await parseBody(req, Body);
    const { data, error } = b.action === "choice"
      ? await supabase.rpc("answer_with_choice", { p_question: id, p_choice: b.choice ?? 0 })
      : await supabase.rpc("skip_question", { p_question: id });
    if (error) throw fromRpcError(error);
    const r = data as { revealed: boolean };
    if (r.revealed) {
      // RLS: only a participant can read the question's conversation
      const { data: q } = await supabase.from("conversation_questions").select("conversation_id").eq("id", id).maybeSingle();
      if (!q?.conversation_id) throw new ApiError(403, "Not allowed");
      const convId = q.conversation_id as string;
      // if this cannot finish inside the budget, the tick's question stage asks the successor (question_work: 'successor')
      after(async () => { try { await advanceAfterReveal(convId, deadline); } catch (e) { console.warn("[question] advance", (e as Error).message); } });
    }
    return ok(r);
  });
}
