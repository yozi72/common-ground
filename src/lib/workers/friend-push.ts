// Neutral push for new friend messages. Rows are queued by the database only
// when the recipient opted in (friend_push_enabled), the thread isn't muted and
// nothing was pushed for that thread in the last 10 minutes. The text never
// includes content or who it is from.
//
// Delivery is tracked per device in push_queue.deliveries, so a device that
// failed transiently is retried (bounded backoff in the database) while devices
// that already got the alert are not sent again. Right before every device
// send the row is re-checked (still my claim, still wanted: consent, mute,
// friendship, blocks, unread); every completion update is conditional on the
// claim, so a mute/read/removal/block that cancelled the alert meanwhile wins.
//
// Boundary that cannot be closed: once a notification has been handed to the
// push provider it cannot be recalled. A cancellation that lands between the
// re-check and the provider's acceptance still results in one delivered alert.
import "server-only";
import webpush from "web-push";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { isAllowedPushEndpoint } from "@/lib/push-endpoint";
import { Deadline, within, DeadlineError } from "./deadline";

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };
// Per-device outcome. "uncertain": the send was started and our budget ran out
// before the provider answered; a Promise timeout does not cancel the request,
// so the alert may or may not have gone out. It counts as a started attempt.
type Delivery = { status: "sent" | "failed" | "gone" | "uncertain"; attempts: number; error?: string; at?: string };
type Deliveries = Record<string, Delivery>;
// timeoutMs is the transport timeout bounded by what is left of the budget.
export type PushSender = (sub: Sub, payload: string, timeoutMs: number) => Promise<void>;

export type FriendPushDeps = {
  send?: PushSender;        // injectable for tests; default is web-push
  configured?: boolean;     // override env.pushConfigured() in tests
};

const GONE = new Set([404, 410]);
const PUSH_TIMEOUT_MS = 10_000;
const MIN_SEND_MS = 3_000;

function defaultSender(): PushSender {
  env.assertLiveDelivery("push"); // hard stop before any provider, whatever the env holds
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@example.com", process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  return (sub, payload, timeoutMs) => webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 6 * 3600, urgency: "normal", timeout: Math.max(1_000, Math.min(PUSH_TIMEOUT_MS, timeoutMs)) }).then(() => undefined);
}

export async function sendFriendMessagePushes(limit = 20, deps: FriendPushDeps = {}, deadline: Deadline = Deadline.none()) {
  const admin = supabaseAdmin();
  const out = { sent: 0, retried: 0, failed: 0, skipped: 0, cancelled: 0, released: 0 };
  if (deadline.remainingMs() < MIN_SEND_MS) return out;                   // claim nothing that cannot start
  const n = Math.max(1, Math.min(limit, Math.floor(deadline.remainingMs() / MIN_SEND_MS)));
  const { data: rows, error } = await admin.rpc("claim_push_queue", { p_limit: n });
  if (error) throw new Error(`claim_push_queue: ${error.message}`);
  if (!rows?.length) return out;
  const configured = deps.configured ?? env.pushConfigured();
  const send = deps.send ?? (configured ? defaultSender() : null);

  for (const row of rows as { id: string; account_id: string; conversation_id: string | null; claimed_at: string; deliveries: Deliveries | null }[]) {
    const finish = (outcome: "sent" | "retry" | "skipped", deliveries: Deliveries, err?: string) =>
      admin.rpc("finish_push_queue", { p_id: row.id, p_claimed_at: row.claimed_at, p_outcome: outcome, p_deliveries: deliveries, p_error: err ?? null }).then((r) => (r.data as string | null) ?? "unknown");
    const deliveries: Deliveries = { ...(row.deliveries ?? {}) };
    // out of time: hand the claim back untouched (queued, due now, attempts and device history kept)
    const release = async () => { const r = await admin.rpc("release_push_queue", { p_id: row.id, p_claimed_at: row.claimed_at, p_deliveries: deliveries }); return (r.data as string | null) ?? "unknown"; };
    if (deadline.remainingMs() < MIN_SEND_MS) { if ((await release()) === "queued") out.released++; else out.cancelled++; continue; }
    if (!send) { await finish("skipped", deliveries, "push not configured"); out.skipped++; continue; }

    // devices are looked up fresh on every attempt (ownership can change on a shared browser);
    // devices with the fewest attempts go first, so one that was never reached makes progress
    // before devices that already failed are retried
    const { data: subsRaw } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("account_id", row.account_id).is("disabled_at", null);
    const subs = ((subsRaw ?? []) as Sub[]).slice().sort((x, y) => (deliveries[x.id]?.attempts ?? 0) - (deliveries[y.id]?.attempts ?? 0));
    const payload = JSON.stringify({ title: "Common Ground", body: "You have a new message.", url: row.conversation_id ? `${env.siteUrl()}/c/${row.conversation_id}` : `${env.siteUrl()}/connections`, tag: `friend-${row.conversation_id ?? "x"}` });
    let aborted: string | null = null;
    let outOfTime = false;
    let started = 0;        // sends started in THIS run
    let failedThisRun = false;   // a genuine failure or an uncertain send in THIS run: only then does the run count as an attempt
    for (const s of subs) {
      if (deliveries[s.id]?.status === "sent") continue; // already delivered on a previous attempt
      if (!isAllowedPushEndpoint(s.endpoint)) { await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString() }).eq("id", s.id); continue; }
      // time is checked BEFORE every device send; a transport never starts after the budget is gone
      if (deadline.remainingMs() < MIN_SEND_MS) { outOfTime = true; break; }
      // still mine, still wanted? (a mute/read/removal/block since the claim cancels it)
      const { data: state } = await admin.rpc("recheck_push_queue", { p_id: row.id, p_claimed_at: row.claimed_at });
      if (state !== "claimed") { aborted = (state as string | null) ?? "unknown"; break; }
      const attempts = (deliveries[s.id]?.attempts ?? 0) + 1;
      started++;
      try {
        await within(deadline, "push", () => send(s, payload, Math.min(PUSH_TIMEOUT_MS, deadline.remainingMs())), PUSH_TIMEOUT_MS);
        deliveries[s.id] = { status: "sent", attempts, at: new Date().toISOString() };
      } catch (e) {
        if (e instanceof DeadlineError) {
          // started, outcome unknown: recorded as an attempt, retried like a failure (the provider may have delivered)
          deliveries[s.id] = { status: "uncertain", attempts, error: "deadline reached during send; delivery uncertain" };
          failedThisRun = true; outOfTime = true; break;
        }
        const status = (e as { statusCode?: number }).statusCode;
        const msg = `push ${status ?? ""} ${(e as Error).message}`.trim();
        if (status !== undefined && GONE.has(status)) {
          await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString(), failures: 99 }).eq("id", s.id);
          deliveries[s.id] = { status: "gone", attempts, error: msg };
        } else {
          deliveries[s.id] = { status: "failed", attempts, error: msg };
          failedThisRun = true;
        }
      }
    }
    if (aborted) { out.cancelled++; continue; } // the row's state was changed by someone else; nothing to overwrite
    // Out of time with no genuine failure in this run (nothing started, or only successes): hand the claim back
    // with the sent devices recorded and no attempt consumed. Out of time after a genuine failure or an
    // uncertain send: the run counts as an attempt (bounded retries, backoff) so repeated partial runs cannot
    // exceed the retry cap; devices not reached are tried first next time.
    if (outOfTime && !failedThisRun) { if ((await release()) === "queued") out.released++; else out.cancelled++; continue; }
    void started;
    const states = Object.values(deliveries);
    const notReached = subs.filter((d) => !deliveries[d.id] && isAllowedPushEndpoint(d.endpoint));
    const transient = states.filter((d) => d.status === "failed" || d.status === "uncertain");
    if (transient.length || (outOfTime && notReached.length)) {
      const r = await finish("retry", deliveries, transient.map((d) => d.error).filter(Boolean).join("; ") || "push failed");
      if (r === "failed") out.failed++; else if (r === "queued") out.retried++; else out.cancelled++;
    } else if (states.some((d) => d.status === "sent")) {
      const r = await finish("sent", deliveries);
      if (r === "sent") out.sent++; else out.cancelled++;
    } else {
      await finish("skipped", deliveries, "no device");
      out.skipped++;
    }
  }
  return out;
}
