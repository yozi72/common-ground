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
  const [{ data: review }, { data: reports }, { data: appeals }, { data: config }, { count: waiting }, { data: metrics }] = await Promise.all([
    admin.from("pending_messages").select("id, conversation_id, kind, body, status, attempts, last_error, user_explanation, created_at, moderation_decisions(decision, categories, detector_hits, provider, confidence, created_at)")
      .in("status", ["review", "pending"]).order("created_at").limit(50),
    admin.from("reports").select("id, conversation_id, reason, details, status, message_ids, created_at").in("status", ["open", "reviewing"]).order("created_at").limit(50),
    admin.from("appeals").select("id, note, status, created_at, pending_messages(id, body, status, user_explanation)").eq("status", "open").order("created_at").limit(50),
    admin.from("policy_config").select("key, value").order("key"),
    admin.from("availability_requests").select("*", { count: "exact", head: true }).eq("status", "waiting"),
    admin.rpc("metrics_summary", { p_since: since }),
  ]);

  // Context for reports: the last 20 approved messages in each reported conversation.
  const convIds = [...new Set((reports ?? []).map((r) => r.conversation_id).filter(Boolean))] as string[];
  const { data: ctx } = convIds.length
    ? await admin.from("approved_messages").select("id, conversation_id, sender_participant_id, body, created_at").in("conversation_id", convIds).order("created_at", { ascending: false }).limit(20 * convIds.length)
    : { data: [] };

  return <AdminConsole review={(review ?? []) as never} reports={(reports ?? []) as never} appeals={(appeals ?? []) as never} config={(config ?? []) as never} context={(ctx ?? []) as never} waiting={waiting ?? 0} metrics={(metrics ?? null) as never} />;
}
