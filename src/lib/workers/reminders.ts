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
import { Deadline, within, DeadlineError } from "./deadline";

const MAX_ATTEMPTS = 3;
const PUSH_TIMEOUT_MS = 10_000;
const EMAIL_TIMEOUT_MS = 15_000;
const MIN_SEND_MS = 3_000;             // don't claim a send that cannot even start
const STALE_CLAIM_MS = 3 * 60_000;     // a claim this old belongs to a worker that died

export type ReminderDeps = {
  sendPush?: (sub: { endpoint: string; p256dh: string; auth: string }, payload: string, ttlSeconds: number, timeoutMs?: number) => Promise<void>;
  sendEmail?: (to: string, subject: string, text: string, opts: { unsubscribeUrl: string; idempotencyKey: string; timeoutMs?: number }) => Promise<void>;
  pushConfigured?: boolean;
  emailConfigured?: boolean;
};


export async function sendDueReminders(nowMs = Date.now(), deadline: Deadline = Deadline.none(), deps: ReminderDeps = {}) {
  const admin = supabaseAdmin();
  const cfg = await getScheduleConfig();
  const out = { session: null as string | null, push: { sent: 0, failed: 0, skipped: 0, disabled: 0, released: 0 }, email: { sent: 0, failed: 0, skipped: 0, released: 0 }, deferred: 0 };
  const pushOn = deps.pushConfigured ?? env.pushConfigured();
  const emailOn = deps.emailConfigured ?? env.emailConfigured();
  const doPush = deps.sendPush ?? ((sub, payload, ttl, timeoutMs) => { env.assertLiveDelivery("push"); return webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: ttl, urgency: "high", timeout: Math.max(1_000, Math.min(PUSH_TIMEOUT_MS, timeoutMs ?? PUSH_TIMEOUT_MS)) }).then(() => undefined); });
  const doEmail = deps.sendEmail ?? sendEmail;

  // Only one lead time is supported per run per pref row; group by minutes_before.
  const { data: prefs } = await admin.from("reminder_prefs").select("account_id, push_enabled, email_enabled, mode, days, next_session_start, minutes_before")
    .or("push_enabled.eq.true,email_enabled.eq.true");
  if (!prefs?.length) return out;

  const byLead = new Map<number, typeof prefs>();
  for (const p of prefs) byLead.set(p.minutes_before, [...(byLead.get(p.minutes_before) ?? []), p]);

  if (pushOn && !deps.sendPush) webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@example.com", process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);

  for (const [lead, rows] of byLead) {
    const session = sessionDueForReminder(nowMs, lead, cfg);
    if (!session) continue;
    out.session = new Date(session.start).toISOString();
    const weekday = partsWeekday(session.start, cfg.timezone);
    const sessionIso = new Date(session.start).toISOString();

    for (const p of rows) {
      const wants = p.mode === "daily" || (p.mode === "weekdays" && (p.days as number[]).includes(weekday)) || (p.mode === "next" && p.next_session_start && Date.parse(p.next_session_start) === session.start);
      if (!wants) continue;

      // out of budget: leave the rest unclaimed; the next minute's tick picks it up
      if (deadline.remainingMs() < MIN_SEND_MS) { out.deferred++; continue; }
      if (p.push_enabled) {
        const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("account_id", p.account_id).is("disabled_at", null);
        for (const s of subs ?? []) {
          if (deadline.remainingMs() < MIN_SEND_MS) { out.deferred++; break; }
          const claim = await claimSend(admin, p.account_id, sessionIso, "push", s.id);
          if (!claim) continue;
          if (!pushOn) { await finish(admin, claim, "skipped", "push not configured"); out.push.skipped++; continue; }
          if (!isAllowedPushEndpoint(s.endpoint)) {
            // never contact an endpoint outside the allowlist, whatever is stored
            await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString() }).eq("id", s.id);
            await finish(admin, claim, "skipped", "endpoint not allowed"); out.push.skipped++; continue;
          }
          let started = false;
          try {
            const payload = JSON.stringify({ title: "Common Ground", body: `Tonight's conversation hour starts in ${lead} minutes.`, url: `${env.siteUrl()}/lobby`, tag: `session-${sessionIso}` });
            await within(deadline, "push", () => { started = true; return doPush(s, payload, lead * 60, Math.min(PUSH_TIMEOUT_MS, deadline.remainingMs())); }, PUSH_TIMEOUT_MS);
            await finish(admin, claim, "sent", null);
            out.push.sent++;
          } catch (e) {
            if (e instanceof DeadlineError) {
              if (!started) { if (await releaseSend(admin, claim)) out.push.released++; continue; }                 // never started: no attempt consumed
              await retryOrFail(admin, claim, "deadline reached during send; delivery uncertain"); out.push.failed++; continue;   // started: counts, retried
            }
            const status = (e as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString(), failures: 99 }).eq("id", s.id);
              await finish(admin, claim, "failed", `subscription gone (${status})`);
              out.push.disabled++;
            } else {
              await retryOrFail(admin, claim, `push ${status ?? ""} ${(e as Error).message}`.trim());
              out.push.failed++;
            }
          }
        }
      }

      if (p.email_enabled && emailOn) {
        if (deadline.remainingMs() < MIN_SEND_MS) { out.deferred++; continue; }
        const claim = await claimSend(admin, p.account_id, sessionIso, "email", "email");
        if (!claim) continue;
        let started = false;
        try {
          const { data: user } = await admin.auth.admin.getUserById(p.account_id);
          const to = user?.user?.email;
          if (!to) throw new Error("no email");
          const t = formatSessionTime(session, cfg.timezone, cfg.timezone);
          const unsub = `${env.siteUrl()}/api/reminders/unsubscribe?t=${unsubscribeToken(p.account_id)}`;
          await within(deadline, "email", () => { started = true; return doEmail(to, "Common Ground: the conversation hour starts soon", `Today's session starts in ${lead} minutes (${t.range} ${t.tzName}).\n\nJoin at the start for the best chance of a match: ${env.siteUrl()}/lobby\n\nStop these emails: ${unsub}\nOr manage reminders under Profile → Reminders.`, { unsubscribeUrl: unsub, idempotencyKey: `reminder/${claim.id}`, timeoutMs: Math.min(EMAIL_TIMEOUT_MS, deadline.remainingMs()) }); }, EMAIL_TIMEOUT_MS);
          await finish(admin, claim, "sent", null);
          out.email.sent++;
        } catch (e) {
          if (e instanceof DeadlineError && !started) { if (await releaseSend(admin, claim)) out.email.released++; continue; }   // never started: no attempt consumed
          // a deadline after the send started is uncertain (Resend dedups on the idempotency key; SMTP may duplicate on retry)
          await retryOrFail(admin, claim, e instanceof DeadlineError ? "deadline reached during send; delivery uncertain" : (e as Error).message);
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

// The provider call never started (the budget ran out on the device or address
// lookup): hand the claim back as it was, conditional on it still being ours.
async function releaseSend(admin: ReturnType<typeof supabaseAdmin>, claim: Claim) {
  const { data } = await admin.rpc("release_reminder_send", { p_id: claim.id, p_attempts: claim.attempts });
  return data === true;
}

// Insert-or-nothing claim; a failed earlier attempt (below the cap) can be
// re-claimed, and so can a claim a dead worker left behind (older than STALE_CLAIM_MS).
async function claimSend(admin: ReturnType<typeof supabaseAdmin>, account: string, session: string, channel: "push" | "email", target: string): Promise<Claim | null> {
  const { data: inserted } = await admin.from("reminder_sends").insert({ account_id: account, session_start: session, channel, target, status: "claimed", attempts: 1, claimed_at: new Date().toISOString() })
    .select("id, attempts").maybeSingle();
  if (inserted) return inserted;
  const { data: existing } = await admin.from("reminder_sends").select("id, status, attempts, claimed_at").eq("account_id", account).eq("session_start", session).eq("channel", channel).eq("target", target).maybeSingle();
  if (!existing || existing.attempts >= MAX_ATTEMPTS) return null;
  const abandoned = existing.status === "claimed" && Date.now() - Date.parse(existing.claimed_at) > STALE_CLAIM_MS;
  if (existing.status === "failed" || abandoned) {
    const { data: upd } = await admin.from("reminder_sends").update({ status: "claimed", attempts: existing.attempts + 1, claimed_at: new Date().toISOString() })
      .eq("id", existing.id).eq("status", existing.status).eq("attempts", existing.attempts).select("id, attempts").maybeSingle();   // only if nobody else got there first
    return upd ?? null;
  }
  return null;
}

// Terminal writes are conditional on the claim still being ours (status
// 'claimed' with the attempt count we set): a stale worker whose claim was
// reclaimed or already completed by another worker changes nothing.
async function finish(admin: ReturnType<typeof supabaseAdmin>, claim: Claim, status: "sent" | "failed" | "skipped", error: string | null) {
  await admin.from("reminder_sends").update({ status, last_error: error, sent_at: status === "sent" ? new Date().toISOString() : null })
    .eq("id", claim.id).eq("status", "claimed").eq("attempts", claim.attempts);
}

async function retryOrFail(admin: ReturnType<typeof supabaseAdmin>, claim: Claim, error: string) {
  // status 'failed' with attempts < MAX lets the next tick retry inside the window
  await finish(admin, claim, "failed", error.slice(0, 300));
}

// RFC 8058 one-click unsubscribe headers (mail providers POST "List-Unsubscribe=One-Click"
// to the URL; a plain GET of the same URL only shows a confirmation page). Resend sends
// carry an Idempotency-Key so a retried call can't double-deliver.
async function sendEmail(to: string, subject: string, text: string, opts: { unsubscribeUrl: string; idempotencyKey: string; timeoutMs?: number }) {
  env.assertLiveDelivery("email"); // hard stop before any provider, whatever the env holds
  const t = Math.max(1_000, Math.min(EMAIL_TIMEOUT_MS, opts.timeoutMs ?? EMAIL_TIMEOUT_MS));   // transport timeout bounded by the remaining budget
  const headers = { "List-Unsubscribe": `<${opts.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  const key = env.resendApiKey();
  if (key) {
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": opts.idempotencyKey }, body: JSON.stringify({ from: env.emailFrom(), to, subject, text, headers }), signal: AbortSignal.timeout(t) });
    if (!res.ok) throw new Error(`resend ${res.status}`);
    return;
  }
  const smtp = env.smtp();
  if (!smtp) throw new Error("no sender");
  const transport = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.port === 465, auth: { user: smtp.user, pass: smtp.pass }, connectionTimeout: Math.min(10_000, t), socketTimeout: t });
  await transport.sendMail({ from: `"${smtp.senderName}" <${smtp.user}>`, to, subject, text, headers });
}
