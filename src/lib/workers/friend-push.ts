// Neutral push for new friend messages. Rows are queued by the database only
// when the recipient opted in (friend_push_enabled), the thread isn't muted and
// nothing was pushed for that thread in the last 10 minutes. The text never
// includes content or who it is from.
import "server-only";
import webpush from "web-push";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { isAllowedPushEndpoint } from "@/lib/push-endpoint";

export async function sendFriendMessagePushes(limit = 20) {
  const admin = supabaseAdmin();
  const out = { sent: 0, failed: 0, skipped: 0 };
  const { data: rows, error } = await admin.rpc("claim_push_queue", { p_limit: limit });
  if (error) throw new Error(`claim_push_queue: ${error.message}`);
  if (!rows?.length) return out;
  const configured = env.pushConfigured();
  if (configured) webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@example.com", process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);

  for (const row of rows as { id: string; account_id: string; conversation_id: string | null }[]) {
    if (!configured) { await admin.from("push_queue").update({ status: "skipped", last_error: "push not configured" }).eq("id", row.id); out.skipped++; continue; }
    // still opted in? (the preference may have changed since queueing)
    const { data: pref } = await admin.from("reminder_prefs").select("friend_push_enabled").eq("account_id", row.account_id).maybeSingle();
    if (!pref?.friend_push_enabled) { await admin.from("push_queue").update({ status: "skipped", last_error: "opted out" }).eq("id", row.id); out.skipped++; continue; }
    const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("account_id", row.account_id).is("disabled_at", null);
    let delivered = 0; let lastErr: string | null = null;
    for (const s of subs ?? []) {
      if (!isAllowedPushEndpoint(s.endpoint)) { await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString() }).eq("id", s.id); continue; }
      try {
        const payload = JSON.stringify({ title: "Common Ground", body: "You have a new message.", url: row.conversation_id ? `${env.siteUrl()}/c/${row.conversation_id}` : `${env.siteUrl()}/connections`, tag: `friend-${row.conversation_id ?? "x"}` });
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600, urgency: "normal" });
        delivered++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        lastErr = `push ${status ?? ""} ${(e as Error).message}`.trim();
        if (status === 404 || status === 410) await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString(), failures: 99 }).eq("id", s.id);
      }
    }
    if (delivered > 0) { await admin.from("push_queue").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", row.id); out.sent++; }
    else { await admin.from("push_queue").update({ status: subs?.length ? "failed" : "skipped", last_error: lastErr ?? "no device" }).eq("id", row.id); if (subs?.length) out.failed++; else out.skipped++; }
  }
  return out;
}
