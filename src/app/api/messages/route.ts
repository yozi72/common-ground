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
export const maxDuration = 60;

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const b = await parseBody(req, Body);
    const { data, error } = await supabase.rpc("submit_message", {
      p_conversation: b.conversation_id, p_client_send_id: b.client_send_id, p_body: b.body,
      p_kind: b.kind, p_question: b.question_id ?? null,
    });
    if (error) throw fromRpcError(error);
    const pendingId = data as string;
    // immediate check, bounded well inside the route's 60 s limit; the tick retries anything missed
    after(async () => { await processPendingById(pendingId, Deadline.in(45_000)); });
    return ok({ pending_id: pendingId, status: "pending" });
  });
}
