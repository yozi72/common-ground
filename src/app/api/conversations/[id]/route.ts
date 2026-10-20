import { z } from "zod";
import { handle, ok, parseBody, requireUser, fromRpcError, ApiError } from "@/lib/api";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("heartbeat") }),
  z.object({ action: z.literal("leave") }),
  z.object({ action: z.literal("block") }),
  z.object({
    action: z.literal("report"),
    reason: z.enum(["harassment", "threat", "hate", "identity_fishing", "spam", "other"]),
    details: z.string().max(2000).optional(),
    message_ids: z.array(z.string().uuid()).max(20).optional(),
    also_block: z.boolean().default(false),
  }),
  z.object({ action: z.literal("connection_decision"), decision: z.boolean() }),
  z.object({
    action: z.literal("reflection"),
    felt_understood: z.number().int().min(1).max(5).optional(),
    recognized_shared: z.number().int().min(1).max(5).optional(),
    would_repeat: z.boolean().optional(),
    free_text: z.string().max(1000).optional(),
  }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const { supabase } = await requireUser();
    const b = await parseBody(req, Body);

    switch (b.action) {
      case "heartbeat": {
        const { error } = await supabase.rpc("heartbeat", { p_conversation: id });
        if (error) throw fromRpcError(error);
        return ok();
      }
      case "leave": {
        const { error } = await supabase.rpc("leave_conversation", { p_conversation: id });
        if (error) throw fromRpcError(error);
        return ok();
      }
      case "block": {
        const { error } = await supabase.rpc("block_peer", { p_conversation: id });
        if (error) throw fromRpcError(error);
        return ok();
      }
      case "report": {
        const { data, error } = await supabase.rpc("report_peer", {
          p_conversation: id, p_reason: b.reason, p_details: b.details ?? "", p_message_ids: b.message_ids ?? [], p_also_block: b.also_block,
        });
        if (error) throw fromRpcError(error);
        return ok({ report_id: data });
      }
      case "connection_decision": {
        const { data, error } = await supabase.rpc("set_connection_decision", { p_conversation: id, p_decision: b.decision });
        if (error) throw fromRpcError(error);
        return ok(data);
      }
      case "reflection": {
        const { data: pid } = await supabase.rpc("my_participant_id", { p_conversation: id });
        if (!pid) throw new ApiError(403, "Not allowed");
        const { error } = await supabase.from("session_reflections").upsert({
          conversation_id: id, participant_id: pid,
          felt_understood: b.felt_understood ?? null, recognized_shared: b.recognized_shared ?? null,
          would_repeat: b.would_repeat ?? null, free_text: b.free_text ?? null,
        }, { onConflict: "conversation_id,participant_id" });
        if (error) throw fromRpcError(error);
        return ok();
      }
    }
  });
}
