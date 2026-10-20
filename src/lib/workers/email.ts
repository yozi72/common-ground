// Email outbox worker. Sends via Resend when RESEND_API_KEY is set; otherwise
// marks rows 'skipped' and logs, so nothing silently pretends to be sent.
import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

const TEMPLATES: Record<string, (siteUrl: string) => { subject: string; text: string }> = {
  invitation: (site) => ({
    subject: "Common Ground: someone is ready to talk",
    text: `You asked to be told when a conversation partner was found. The invitation expires in a few minutes.\n\nOpen: ${site}/lobby`,
  }),
  reconnect_invitation: (site) => ({
    subject: "Common Ground: a past conversation partner would like to talk again",
    text: `Someone you connected with earlier has asked to reconnect. Nothing happens unless you accept.\n\nOpen: ${site}/connections`,
  }),
};

export async function sendQueuedEmails(limit = 20) {
  const admin = supabaseAdmin();
  const { data: rows } = await admin.from("email_outbox").select("id, account_id, template").eq("status", "queued").order("created_at").limit(limit);
  if (!rows?.length) return { sent: 0, skipped: 0, failed: 0 };
  const key = env.resendApiKey();
  let sent = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    const tpl = TEMPLATES[row.template];
    if (!tpl) { await admin.from("email_outbox").update({ status: "failed", last_error: "unknown template" }).eq("id", row.id); failed++; continue; }
    if (!key) {
      await admin.from("email_outbox").update({ status: "skipped", last_error: "RESEND_API_KEY not configured" }).eq("id", row.id);
      skipped++; continue;
    }
    try {
      const { data: user } = await admin.auth.admin.getUserById(row.account_id);
      const to = user?.user?.email;
      if (!to) throw new Error("no email on account");
      const { subject, text } = tpl(env.siteUrl());
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.emailFrom(), to, subject, text }),
      });
      if (!res.ok) throw new Error(`resend ${res.status}`);
      await admin.from("email_outbox").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", row.id);
      sent++;
    } catch (e) {
      await admin.from("email_outbox").update({ status: "failed", attempts: 1, last_error: (e as Error).message }).eq("id", row.id);
      failed++;
    }
  }
  return { sent, skipped, failed };
}
