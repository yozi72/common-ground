import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { AdminConsole } from "./AdminConsole";
import { serverNow } from "@/lib/schedule-config";

export const dynamic = "force-dynamic";

// Review console. Access: is_admin() for the signed-in user; data is then
// read with the service role because pending/moderation rows are not
// client-readable by design.
export default async function AdminPage() {
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (!isAdmin) redirect("/lobby");

  const admin = supabaseAdmin();
  const since = new Date(serverNow() - 14 * 86400_000).toISOString();
  const [{ data: review }, { data: reports }, { data: appeals }, { data: config }, { count: waiting }, { data: metrics, error: metricsError }] = await Promise.all([
    admin.from("pending_messages").select("id, conversation_id, kind, body, status, attempts, last_error, user_explanation, created_at, moderation_decisions(decision, categories, detector_hits, provider, confidence, created_at)")
      .in("status", ["review", "pending"]).order("created_at").limit(50),
    admin.from("reports").select("id, conversation_id, reason, details, status, message_ids, created_at").in("status", ["open", "reviewing"]).order("created_at").limit(50),
    admin.from("appeals").select("id, note, status, created_at, pending_messages(id, body, status, user_explanation)").eq("status", "open").order("created_at").limit(50),
    admin.from("policy_config").select("key, value").order("key"),
    admin.from("availability_requests").select("*", { count: "exact", head: true }).eq("status", "waiting"),
    // service-role call to the metrics function itself (admin_metrics wraps it for
    // signed-in admins; a service-role session has no auth.uid() to check)
    admin.rpc("metrics_summary", { p_since: since }),
  ]);

  // Context for reports comes from the evidence snapshot taken when the report was
  // filed (what the reporter could see then), not from the live chat, which may
  // have been cleared since.
  const reportIds = (reports ?? []).map((r) => r.id);
  const { data: evidence } = reportIds.length ? await admin.from("report_evidence").select("report_id, cited, context").in("report_id", reportIds) : { data: [] };

  return <AdminConsole review={(review ?? []) as never} reports={(reports ?? []) as never} appeals={(appeals ?? []) as never} config={(config ?? []) as never} evidence={(evidence ?? []) as never} waiting={waiting ?? 0} metrics={(metrics ?? null) as never} metricsError={metricsError?.message ?? null} />;
}
