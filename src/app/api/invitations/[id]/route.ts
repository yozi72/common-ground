import { z } from "zod";
import { after } from "next/server";
import { handle, ok, parseBody, requireUser, fromRpcError } from "@/lib/api";
import { generateNextQuestion } from "@/lib/workers/questions";
import { Deadline } from "@/lib/workers/deadline";

// Hosting: every model-calling route exports maxDuration = 60 (checked against
// the Vercel project: see NOTES.md, item 10) and establishes ONE deadline at
// entry (ROUTE_BUDGET_MS = 45 s) that covers auth, database work, the model
// call with its retries and any follow-up generation; what cannot finish in
// time is left recoverable (claims are released, the tick retries, questions
// fall back to the bank).
export const maxDuration = 60;
const ROUTE_BUDGET_MS = 45_000;

const Body = z.object({ accept: z.boolean() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const deadline = Deadline.in(ROUTE_BUDGET_MS);   // one budget from request entry; the first question runs inside it after the response
    const { id } = await ctx.params;
    const { supabase } = await requireUser();
    const body = await parseBody(req, Body);
    const { data, error } = await supabase.rpc("respond_invitation", { p_invitation: id, p_accept: body.accept });
    if (error) throw fromRpcError(error);
    const result = data as { status: string; conversation_id?: string };
    if (result.status === "opened" && result.conversation_id) {
      const convId = result.conversation_id;
      after(async () => {
        // if this fails or runs out of time, the tick's question stage asks the first question
        try { await generateNextQuestion(convId, "opening", { deadlineMs: deadline.remainingMs() }); } catch (e) { console.warn("[invitation] first question", (e as Error).message); }
      });
    }
    return ok(result);
  });
}
