import { z } from "zod";
import { after } from "next/server";
import { handle, ok, parseBody, requireUser, fromRpcError } from "@/lib/api";
import { processPendingById } from "@/lib/workers/moderation";
import { Deadline } from "@/lib/workers/deadline";

// Hosting: every model-calling route exports maxDuration = 60 (checked against
// the Vercel project: see NOTES.md, item 10) and establishes ONE deadline at
// entry (ROUTE_BUDGET_MS = 45 s) that covers auth, database work, the model
// call with its retries and any follow-up generation; what cannot finish in
// time is left recoverable (claims are released, the tick retries, questions
// fall back to the bank).
export const maxDuration = 60;
const ROUTE_BUDGET_MS = 45_000;

const Body = z.object({
  action: z.enum(["cancel", "accept_revision", "appeal"]),
  note: z.string().max(1000).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const deadline = Deadline.in(ROUTE_BUDGET_MS);   // one budget from request entry; an accepted revision is moderated inside it
    const { id } = await ctx.params;
    const { supabase } = await requireUser();
    const b = await parseBody(req, Body);
    if (b.action === "cancel") {
      const { error } = await supabase.rpc("cancel_pending", { p_pending: id });
      if (error) throw fromRpcError(error);
      return ok();
    }
    if (b.action === "accept_revision") {
      const { data, error } = await supabase.rpc("accept_revision", { p_pending: id });
      if (error) throw fromRpcError(error);
      const newId = data as string;
      after(async () => { await processPendingById(newId, deadline); });
      return ok({ pending_id: newId });
    }
    const { data, error } = await supabase.rpc("file_appeal", { p_pending: id, p_note: b.note ?? "" });
    if (error) throw fromRpcError(error);
    return ok({ appeal_id: data });
  });
}
