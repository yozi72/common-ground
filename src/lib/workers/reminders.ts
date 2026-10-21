// Reminder delivery. Runs every minute from the database scheduler (pg_cron →
// /api/cron/tick). Idempotent: each (account, session, channel, target) is
// claimed with a unique row before sending, so overlapping runs never double
// send. Failures retry a bounded number of times inside the reminder window;
// after the session starts nothing stale is delivered.
import "server-only";
import webpush from "web-push";
import nodemailer from "nodemailer";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { getScheduleConfig } from "@/lib/schedule-config";
import { sessionDueForReminder, formatSessionTime, partsWeekday } from "@/lib/schedule";
import { unsubscribeToken } from "@/lib/unsubscribe";
import { isAllowedPushEndpoint } from "@/lib/push-endpoint";

const MAX_ATTEMPTS = 3;

function pushConfigured() {
  return !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export async function sendDueReminders(nowMs = Date.now()) {
  const admin = supabaseAdmin();
  const cfg = await getScheduleConfig();
  const out = { session: null as string | null, push: { sent: 0, failed: 0, skipped: 0, disabled: 0 }, email: { sent: 0, failed: 0, skipped: 0 } };

  // Only one lead time is supported per run per pref row; group by minutes_before.
  const { data: prefs } = await admin.from("reminder_prefs").select("account_id, push_enabled, email_enabled, mode, days, next_session_start, minutes_before")
    .or("push_enabled.eq.true,email_enabled.eq.true");
  if (!prefs?.length) return out;

  const byLead = new Map<number, typeof prefs>();
  for (const p of prefs) byLead.set(p.minutes_before, [...(byLead.get(p.minutes_before) ?? []), p]);

  if (pushConfigured()) webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@example.com", process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);

  for (const [lead, rows] of byLead) {
    const session = sessionDueForReminder(nowMs, lead, cfg);
    if (!session) continue;
    out.session = new Date(session.start).toISOString();
    const weekday = partsWeekday(session.start, cfg.timezone);
    const sessionIso = new Date(session.start).toISOString();

    for (const p of rows) {
      const wants = p.mode === "daily" || (p.mode === "weekdays" && (p.days as number[]).includes(weekday)) || (p.mode === "next" && p.next_session_start && Date.parse(p.next_session_start) === session.start);
      if (!wants) continue;

      if (p.push_enabled) {
        const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("account_id", p.account_id).is("disabled_at", null);
        for (const s of subs ?? []) {
          const claim = await claimSend(admin, p.account_id, sessionIso, "push", s.id);
          if (!claim) continue;
          if (!pushConfigured()) { await finish(admin, claim.id, "skipped", "push not configured"); out.push.skipped++; continue; }
          if (!isAllowedPushEndpoint(s.endpoint)) {
            // never contact an endpoint outside the allowlist, whatever is stored
            await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString() }).eq("id", s.id);
            await finish(admin, claim.id, "skipped", "endpoint not allowed"); out.push.skipped++; continue;
          }
          try {
            const payload = JSON.stringify({ title: "Common Ground", body: `Tonight's conversation hour starts in ${lead} minutes.`, url: `${env.siteUrl()}/lobby`, tag: `session-${sessionIso}` });
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: lead * 60, urgency: "high" });
            await finish(admin, claim.id, "sent", null);
            out.push.sent++;
          } catch (e) {
            const status = (e as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString(), failures: 99 }).eq("id", s.id);
              await finish(admin, claim.id, "failed", `subscription gone (${status})`);
              out.push.disabled++;
            } else {
              await retryOrFail(admin, claim, `push ${status ?? ""} ${(e as Error).message}`.trim());
              out.push.failed++;
            }
          }
        }
      }

      if (p.email_enabled && env.emailConfigured()) {
        const claim = await claimSend(admin, p.account_id, sessionIso, "email", "email");
        if (!claim) continue;
        try {
          const { data: user } = await admin.auth.admin.getUserById(p.account_id);
          const to = user?.user?.email;
          if (!to) throw new Error("no email");
          const t = formatSessionTime(session, cfg.timezone, cfg.timezone);
          const unsub = `${env.siteUrl()}/api/reminders/unsubscribe?t=${unsubscribeToken(p.account_id)}`;
          await sendEmail(to, "Common Ground: the conversation hour starts soon", `Today's session starts in ${lead} minutes (${t.range} ${t.tzName}).\n\nJoin at the start for the best chance of a match: ${env.siteUrl()}/lobby\n\nStop these emails: ${unsub}\nOr manage reminders under Profile → Reminders.`, { unsubscribeUrl: unsub, idempotencyKey: `reminder/${claim.id}` });
          await finish(admin, claim.id, "sent", null);
          out.email.sent++;
        } catch (e) {
          await retryOrFail(admin, claim, (e as Error).message);
          out.email.failed++;
        }
      } else if (p.email_enabled) {
        out.email.skipped++;
      }
    }
  }
  return out;
}

type Claim = { id: string; attempts: number };

// Insert-or-nothing claim; a failed earlier attempt (below the cap) can be re-claimed.
async function claimSend(admin: ReturnType<typeof supabaseAdmin>, account: string, session: string, channel: "push" | "email", target: string): Promise<Claim | null> {
  const { data: inserted } = await admin.from("reminder_sends").insert({ account_id: account, session_start: session, channel, target, status: "claimed", attempts: 1 })
    .select("id, attempts").maybeSingle();
  if (inserted) return inserted;
  // exists: retry only if it failed and is under the cap
  const { data: existing } = await admin.from("reminder_sends").select("id, status, attempts").eq("account_id", account).eq("session_start", session).eq("channel", channel).eq("target", target).maybeSingle();
  if (existing && existing.status === "failed" && existing.attempts < MAX_ATTEMPTS) {
    const { data: upd } = await admin.from("reminder_sends").update({ status: "claimed", attempts: existing.attempts + 1 }).eq("id", existing.id).eq("status", "failed").select("id, attempts").maybeSingle();
    return upd ?? null;
  }
  return null;
}

async function finish(admin: ReturnType<typeof supabaseAdmin>, id: string, status: "sent" | "failed" | "skipped", error: string | null) {
  await admin.from("reminder_sends").update({ status, last_error: error, sent_at: status === "sent" ? new Date().toISOString() : null }).eq("id", id);
}

async function retryOrFail(admin: ReturnType<typeof supabaseAdmin>, claim: Claim, error: string) {
  // status 'failed' with attempts < MAX lets the next tick retry inside the window
  await finish(admin, claim.id, "failed", error.slice(0, 300));
}

// RFC 8058 one-click unsubscribe headers (mail providers POST "List-Unsubscribe=One-Click"
// to the URL; a plain GET of the same URL only shows a confirmation page). Resend sends
// carry an Idempotency-Key so a retried call can't double-deliver.
async function sendEmail(to: string, subject: string, text: string, opts: { unsubscribeUrl: string; idempotencyKey: string }) {
  const headers = { "List-Unsubscribe": `<${opts.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  const key = env.resendApiKey();
  if (key) {
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": opts.idempotencyKey }, body: JSON.stringify({ from: env.emailFrom(), to, subject, text, headers }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`resend ${res.status}`);
    return;
  }
  const smtp = env.smtp();
  if (!smtp) throw new Error("no sender");
  const transport = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.port === 465, auth: { user: smtp.user, pass: smtp.pass }, connectionTimeout: 10_000, socketTimeout: 15_000 });
  await transport.sendMail({ from: `"${smtp.senderName}" <${smtp.user}>`, to, subject, text, headers });
}
