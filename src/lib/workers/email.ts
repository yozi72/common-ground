// Email outbox worker (match-ready notices). Rows are claimed atomically with a
// lease (claim_email_outbox), re-checked for relevance right before sending
// (recheck_email_outbox: invitation still pending, notice still requested) and
// finished conditionally on the claim (finish_email_outbox). Transient provider
// failures retry with backoff up to 5 attempts; permanent ones (no address,
// unknown template) fail at once.
//
// Duplicate-delivery window: Resend sends carry an Idempotency-Key (the outbox
// row id), so a retry after a timed-out-but-delivered call does not double
// send. SMTP has no such key: if the SMTP call succeeds but the process dies
// before finish_email_outbox runs, the lease expires and the notice can be sent
// a second time. That window is bounded by the lease (2 minutes).
import "server-only";
import nodemailer from "nodemailer";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env, LiveDeliveryBlockedError } from "@/lib/env";
import { Deadline } from "./deadline";

export type EmailDeliverer = (args: { id: string; to: string; subject: string; text: string }) => Promise<string>;

export class PermanentEmailError extends Error {}

async function deliverDefault({ id, to, subject, text }: { id: string; to: string; subject: string; text: string }): Promise<string> {
  if (!env.liveDeliveryAllowed()) throw new PermanentEmailError(new LiveDeliveryBlockedError("email").message); // hard stop, no retry
  const key = env.resendApiKey();
  if (key) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `outbox/${id}` },
      body: JSON.stringify({ from: env.emailFrom(), to, subject, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new PermanentEmailError(`resend ${res.status}`);
    if (!res.ok) throw new Error(`resend ${res.status}`);
    return "resend";
  }
  const smtp = env.smtp();
  if (smtp) {
    const transport = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.port === 465, auth: { user: smtp.user, pass: smtp.pass }, connectionTimeout: 10_000, socketTimeout: 15_000 });
    await transport.sendMail({ from: `"${smtp.senderName}" <${smtp.user}>`, to, subject, text });
    return "smtp";
  }
  throw new PermanentEmailError("no sender");
}

const TEMPLATES: Record<string, (siteUrl: string) => { subject: string; text: string }> = {
  invitation: (site) => ({
    subject: "Common Ground: someone is ready to talk",
    text: `You asked to be told when a conversation partner was found. The invitation expires in a few minutes.\n\nOpen: ${site}/lobby`,
  }),
};

export async function sendQueuedEmails(limit = 20, deadline: Deadline = Deadline.none(), deps: { deliver?: EmailDeliverer; configured?: boolean } = {}) {
  const admin = supabaseAdmin();
  const out = { sent: 0, retried: 0, failed: 0, skipped: 0, cancelled: 0 };
  const configured = deps.configured ?? env.emailConfigured();
  const deliver = deps.deliver ?? deliverDefault;
  const { data: rows, error } = await admin.rpc("claim_email_outbox", { p_limit: limit });
  if (error) throw new Error(`claim_email_outbox: ${error.message}`);
  for (const row of (rows ?? []) as { id: string; account_id: string; template: string; claim_token: string }[]) {
    const finish = (outcome: "sent" | "retry" | "failed" | "skipped", err?: string) =>
      admin.rpc("finish_email_outbox", { p_id: row.id, p_claim_token: row.claim_token, p_outcome: outcome, p_error: err ?? null }).then((r) => (r.data as string | null) ?? "unknown");
    if (deadline.remainingMs() < 20_000) { await finish("retry", "deadline"); out.retried++; continue; } // back to the queue, lease released
    const tpl = TEMPLATES[row.template];
    if (!tpl) { await finish("failed", "unknown template"); out.failed++; continue; }
    if (!configured) { await finish("skipped", "no email sender configured (RESEND_API_KEY or SMTP_*)"); out.skipped++; continue; }
    // still mine, still relevant? (the invitation may have been declined or expired since the claim)
    const { data: state } = await admin.rpc("recheck_email_outbox", { p_id: row.id, p_claim_token: row.claim_token });
    if (state !== "claimed") { out.cancelled++; continue; }
    try {
      const { data: user } = await admin.auth.admin.getUserById(row.account_id);
      const to = user?.user?.email;
      if (!to) throw new PermanentEmailError("no email on account");
      const { subject, text } = tpl(env.siteUrl());
      const via = await deliver({ id: row.id, to, subject, text });
      const r = await finish("sent", via);
      if (r === "sent") out.sent++; else out.cancelled++;
    } catch (e) {
      const permanent = e instanceof PermanentEmailError;
      const r = await finish(permanent ? "failed" : "retry", (e as Error).message);
      if (r === "queued") out.retried++; else if (r === "failed") out.failed++; else out.cancelled++;
    }
  }
  return out;
}
