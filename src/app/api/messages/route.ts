import { z } from "zod";
import { after } from "next/server";
import { handle, ok, parseBody, requireUser, fromRpcError } from "@/lib/api";
import { processPendingById } from "@/lib/workers/moderation";
import { Deadline } from "@/lib/workers/deadline";

const Body = z.object({
  conversation_id: z.string().uuid(),
  client_send_id: z.string().min(8).max(80),
  body: z.string().trim().min(1).max(2000),
  kind: z.enum(["chat", "answer"]).default("chat"),
  question_id: z.string().uuid().optional(),
});

// Send = create a pending message. The recipient sees nothing until the
// moderation worker approves it. Idempotent on client_send_id.
// Hosting: every model-calling route exports maxDuration = 60 (checked against
// the Vercel project: see NOTES.md, item 10) and establishes ONE deadline at
// entry (ROUTE_BUDGET_MS = 45 s) that covers auth, database work, the model
// call with its retries and any follow-up generation; what cannot finish in
// time is left recoverable (claims are released, the tick retries, questions
// fall back to the bank).
export const maxDuration = 60;
const ROUTE_BUDGET_MS = 45_000;

export async function POST(req: Request) {
  return handle(async () => {
    const deadline = Deadline.in(ROUTE_BUDGET_MS);   // one budget from request entry; moderation runs inside it after the response
    const { supabase } = await requireUser();
    const b = await parseBody(req, Body);
    const { data, error } = await supabase.rpc("submit_message", {
      p_conversation: b.conversation_id, p_client_send_id: b.client_send_id, p_body: b.body,
      p_kind: b.kind, p_question: b.question_id ?? null,
    });
    if (error) throw fromRpcError(error);
    const pendingId = data as string;
    // immediate check inside the entry budget; a claim that cannot finish is released and the tick retries it
    after(async () => { await processPendingById(pendingId, deadline); });
    return ok({ pending_id: pendingId, status: "pending" });
  });
}
