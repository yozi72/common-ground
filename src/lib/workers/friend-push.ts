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
import { Deadline, within } from "./deadline";

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };
type Delivery = { status: "sent" | "failed" | "gone"; attempts: number; error?: string; at?: string };
type Deliveries = Record<string, Delivery>;
export type PushSender = (sub: Sub, payload: string) => Promise<void>;

export type FriendPushDeps = {
  send?: PushSender;        // injectable for tests; default is web-push
  configured?: boolean;     // override env.pushConfigured() in tests
};

const GONE = new Set([404, 410]);
const PUSH_TIMEOUT_MS = 10_000;
const MIN_SEND_MS = 3_000;

function defaultSender(): PushSender {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@example.com", process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  return (sub, payload) => webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 6 * 3600, urgency: "normal", timeout: PUSH_TIMEOUT_MS }).then(() => undefined);
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
    if (deadline.remainingMs() < MIN_SEND_MS) {
      // out of time: hand the claim back (queued, due now, attempt not consumed)
      await admin.rpc("finish_push_queue", { p_id: row.id, p_claimed_at: row.claimed_at, p_outcome: "retry", p_deliveries: deliveries, p_error: "deadline", p_max_attempts: 1_000_000 });
      await admin.from("push_queue").update({ next_attempt_at: new Date().toISOString(), attempts: 0 }).eq("id", row.id).eq("status", "queued");
      out.released++; continue;
    }
    if (!send) { await finish("skipped", deliveries, "push not configured"); out.skipped++; continue; }

    // devices are looked up fresh on every attempt (ownership can change on a shared browser)
    const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("account_id", row.account_id).is("disabled_at", null);
    const payload = JSON.stringify({ title: "Common Ground", body: "You have a new message.", url: row.conversation_id ? `${env.siteUrl()}/c/${row.conversation_id}` : `${env.siteUrl()}/connections`, tag: `friend-${row.conversation_id ?? "x"}` });
    let aborted: string | null = null;
    for (const s of (subs ?? []) as Sub[]) {
      if (deliveries[s.id]?.status === "sent") continue; // already delivered on a previous attempt
      if (!isAllowedPushEndpoint(s.endpoint)) { await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString() }).eq("id", s.id); continue; }
      // still mine, still wanted? (a mute/read/removal/block since the claim cancels it)
      const { data: state } = await admin.rpc("recheck_push_queue", { p_id: row.id, p_claimed_at: row.claimed_at });
      if (state !== "claimed") { aborted = (state as string | null) ?? "unknown"; break; }
      try {
        await within(deadline, "push", send(s, payload), PUSH_TIMEOUT_MS);
        deliveries[s.id] = { status: "sent", attempts: (deliveries[s.id]?.attempts ?? 0) + 1, at: new Date().toISOString() };
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        const msg = `push ${status ?? ""} ${(e as Error).message}`.trim();
        if (status !== undefined && GONE.has(status)) {
          await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString(), failures: 99 }).eq("id", s.id);
          deliveries[s.id] = { status: "gone", attempts: (deliveries[s.id]?.attempts ?? 0) + 1, error: msg };
        } else {
          deliveries[s.id] = { status: "failed", attempts: (deliveries[s.id]?.attempts ?? 0) + 1, error: msg };
        }
      }
    }
    if (aborted) { out.cancelled++; continue; } // the row's state was changed by someone else; nothing to overwrite

    const states = Object.values(deliveries);
    const transient = states.filter((d) => d.status === "failed");
    if (transient.length) {
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
