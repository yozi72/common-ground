import { z } from "zod";
import { handle, ok, parseBody, requireAdmin } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { advanceAfterReveal } from "@/lib/workers/moderation";
import { generateNextQuestion } from "@/lib/workers/questions";
import { Deadline } from "@/lib/workers/deadline";

// Admin review actions. The caller must be the configured admin (is_admin()),
// then the service role applies the decision through the same enforcement
// function the worker uses, so audit rows are identical.
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resolve_pending"), pending_id: z.string().uuid(), decision: z.enum(["allow", "block"]), note: z.string().max(600).optional() }),
  z.object({ action: z.literal("resolve_report"), report_id: z.string().uuid(), status: z.enum(["reviewing", "resolved", "dismissed"]), note: z.string().max(2000).optional() }),
  z.object({ action: z.literal("resolve_appeal"), appeal_id: z.string().uuid(), status: z.enum(["upheld", "overturned"]), note: z.string().max(2000).optional() }),
  z.object({ action: z.literal("set_config"), key: z.string().max(60), value: z.unknown() }),
]);

export const maxDuration = 60; // admin follow-up generation runs inside this budget

export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireAdmin();
    const b = await parseBody(req, Body);
    const admin = supabaseAdmin();

    if (b.action === "resolve_pending") {
      const { data, error } = await admin.rpc("apply_moderation_decision", {
        p_pending: b.pending_id, p_decision: b.decision, p_categories: ["human_review"],
        p_user_explanation: b.decision === "block" ? (b.note ?? "A reviewer decided this message can't be delivered.") : null,
        p_suggested_revision: null, p_confidence: 1, p_detector_hits: [], p_provider: "human", p_model: null, p_raw_valid: true, p_latency_ms: null,
      });
      if (error) throw new Error(error.message);
      const o = (data ?? {}) as { question_due?: boolean; revealed?: boolean };
      const { data: row } = await admin.from("pending_messages").select("conversation_id").eq("id", b.pending_id).single();
      if (row && o.question_due) await generateNextQuestion(row.conversation_id, "mid", { deadlineMs: 40_000 });
      if (row && o.revealed) await advanceAfterReveal(row.conversation_id, Deadline.in(40_000));
      return ok(data);
    }
    if (b.action === "resolve_report") {
      const patch = { status: b.status, resolution_note: b.note ?? null, resolved_by: user.id, resolved_at: b.status === "reviewing" ? null : new Date().toISOString() };
      const { error } = await admin.from("reports").update(patch).eq("id", b.report_id);
      if (error) throw new Error(error.message);
      return ok();
    }
    if (b.action === "resolve_appeal") {
      // appeal + delivery in one transaction: a failed delivery write fails the resolution too
      const { data, error } = await admin.rpc("resolve_appeal", { p_appeal: b.appeal_id, p_status: b.status, p_note: b.note ?? null, p_resolver: user.id });
      if (error) throw new Error(error.message);
      const o = (data ?? {}) as { question_due?: boolean; revealed?: boolean; pending_id?: string };
      if (o.pending_id && (o.question_due || o.revealed)) {
        const { data: row } = await admin.from("pending_messages").select("conversation_id").eq("id", o.pending_id).single();
        if (row && o.question_due) await generateNextQuestion(row.conversation_id, "mid", { deadlineMs: 40_000 });
        if (row && o.revealed) await advanceAfterReveal(row.conversation_id, Deadline.in(40_000));
      }
      return ok(data);
    }
    const { error } = await admin.from("policy_config").upsert({ key: b.key, value: b.value as never, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    return ok();
  });
}
