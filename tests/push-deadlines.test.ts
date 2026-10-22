// Friend-push worker: time is checked before every device send, an
// out-of-time claim is released with its history intact, and nothing ever
// overwrites a cancellation, a reclaim or a completed delivery.
import { describe, it, expect, afterAll } from "vitest";
import { sendFriendMessagePushes } from "@/lib/workers/friend-push";
import { processPendingBatch } from "@/lib/workers/moderation";
import { generateNextQuestion } from "@/lib/workers/questions";
import { Deadline, within, DeadlineError } from "@/lib/workers/deadline";
import { admin, makeUser, deleteUser, openSessionNow, openConversation, finishOpeningRound, resetQueue, LEFT, RIGHT, type TestUser } from "./helpers";

const made: TestUser[] = [];
afterAll(async () => { for (const u of made.splice(0)) await deleteUser(u); });

// a friendship with b opted in to pushes on three devices, and one queued push for b
async function queuedPush(tag: string, devices = 3) {
  await openSessionNow(); await resetQueue();
  // the push queue is shared: leftovers from earlier tests must not be claimed by this one
  await admin().from("push_queue").update({ status: "cancelled", last_error: "test cleanup" }).in("status", ["queued", "claimed"]);
  const a = await makeUser(`${tag}-a`, LEFT); const b = await makeUser(`${tag}-b`, RIGHT); made.push(a, b);
  const conv = await openConversation(a, b);
  await finishOpeningRound(a, b, conv, generateNextQuestion);
  await a.client.rpc("leave_conversation", { p_conversation: conv });
  await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
  await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
  const { data: conns } = await a.client.rpc("friend_threads_overview");
  const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
  await b.client.from("reminder_prefs").upsert({ account_id: b.id, friend_push_enabled: true });
  const subs: string[] = [];
  for (let i = 1; i <= devices; i++) {
    const { data: id } = await b.client.rpc("upsert_push_subscription", { p_endpoint: `https://fcm.googleapis.com/fcm/send/${tag}-${i}-${b.id}`, p_p256dh: "BPdummykeydummykeydummykey", p_auth: "authdummy", p_user_agent: "test" });
    subs.push(id as string);
  }
  await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: `${tag}-m1`, p_body: "hello there" });
  await processPendingBatch();
  const { data: q } = await admin().from("push_queue").select("id, status, attempts, deliveries").eq("account_id", b.id).single();
  expect(q!.status).toBe("queued");
  return { a, b, tid, subs, queueId: q!.id as string, connectionId: conns![0].connection_id as string };
}
const queueRow = async (id: string) => (await admin().from("push_queue").select("status, attempts, deliveries, last_error, next_attempt_at").eq("id", id).single()).data!;
const makeDue = (id: string) => admin().from("push_queue").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", id);

describe("friend push deadlines and release", () => {
  it("within() never starts the work when no time is left", async () => {
    let started = false;
    await expect(within(Deadline.in(0), "x", () => { started = true; return Promise.resolve(1); })).rejects.toThrow(DeadlineError);
    expect(started).toBe(false);
    await expect(within(Deadline.in(10_000), "x", () => Promise.resolve(2), 50)).resolves.toBe(2);
  });

  it("budget expiring between devices: devices sent so far are recorded, the claim is released without an attempt, and later runs skip them", async () => {
    const { subs, queueId } = await queuedPush("pd1");
    const sentTo: string[] = [];
    // simulated transport time: each send takes 4 s of a 6 s budget, so the second device finds under 3 s left
    const base = Date.now(); let elapsed = 0;
    const clock = () => base + elapsed;
    const r1 = await sendFriendMessagePushes(10, { configured: true, send: async (s) => { sentTo.push(s.id); elapsed += 4_000; } }, Deadline.in(6_000, clock));
    expect(r1.released).toBe(1);
    expect(sentTo).toHaveLength(1);
    const after1 = await queueRow(queueId);
    expect(after1.status).toBe("queued");
    expect(after1.attempts).toBe(0);                                   // no attempt consumed by our deadline
    expect(after1.last_error).toMatch(/released/);
    expect(Object.values(after1.deliveries as Record<string, { status: string }>).filter((d) => d.status === "sent")).toHaveLength(1);
    const r2 = await sendFriendMessagePushes(10, { configured: true, send: async (s) => { sentTo.push(s.id); } }, Deadline.none());
    expect(r2.sent).toBe(1);
    expect(sentTo).toHaveLength(3);
    expect(new Set(sentTo).size).toBe(3);                              // the first device was not sent twice
    expect((await queueRow(queueId)).status).toBe("sent");
    expect(subs.every((s) => sentTo.includes(s))).toBe(true);
  });

  it("zero time before dispatch: nothing is claimed, or a claim is handed back before any transport starts", async () => {
    const { queueId } = await queuedPush("pd2");
    let calls = 0;
    const none = await sendFriendMessagePushes(10, { configured: true, send: async () => { calls++; } }, Deadline.in(0));
    expect(none).toMatchObject({ sent: 0, released: 0 });
    expect((await queueRow(queueId)).status).toBe("queued");
    // the budget is enough to claim (3.4 s at the first check) but gone by the per-row check: handed back, transport never started
    let t = Date.now();
    const r = await sendFriendMessagePushes(10, { configured: true, send: async () => { calls++; } }, Deadline.in(4_000, () => (t += 600)));
    expect(r.released).toBe(1);
    expect(calls).toBe(0);
    expect((await queueRow(queueId))).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("a previously failed job released for lack of time keeps its attempts and per-device history", async () => {
    const { queueId } = await queuedPush("pd3", 2);
    const r1 = await sendFriendMessagePushes(10, { configured: true, send: async () => { throw Object.assign(new Error("provider down"), { statusCode: 503 }); } }, Deadline.none());
    expect(r1.retried).toBe(1);
    const failed = await queueRow(queueId);
    expect(failed).toMatchObject({ status: "queued", attempts: 1 });
    expect(Object.values(failed.deliveries as Record<string, { status: string; attempts: number }>).map((d) => d.status)).toEqual(["failed", "failed"]);
    await makeDue(queueId);
    let t = Date.now();
    const r2 = await sendFriendMessagePushes(10, { configured: true, send: async () => undefined }, Deadline.in(4_000, () => (t += 600)));
    expect(r2.released).toBe(1);
    const released = await queueRow(queueId);
    expect(released.attempts).toBe(1);                                  // genuine earlier failure preserved
    expect(Object.values(released.deliveries as Record<string, { status: string; attempts: number }>).every((d) => d.status === "failed" && d.attempts === 1)).toBe(true);
  });

  it("a cancellation (mute) or a reclaim during the sends wins; our outcome never overwrites it", async () => {
    const { b, tid, queueId } = await queuedPush("pd4");
    let n = 0;
    const r = await sendFriendMessagePushes(10, { configured: true, send: async () => { n++; if (n === 1) await b.client.rpc("set_thread_muted", { p_conversation: tid, p_muted: true }); } }, Deadline.none());
    expect(r.cancelled).toBe(1);
    expect(n).toBe(1);                                                   // the re-check before device 2 saw the mute
    expect((await queueRow(queueId)).status).toBe("cancelled");          // the mute cancelled it; our run did not overwrite that
    // reclaim by another worker between our devices
    const { queueId: q2 } = await queuedPush("pd5");
    let m = 0;
    const r2 = await sendFriendMessagePushes(10, { configured: true, send: async () => { m++; if (m === 1) await admin().from("push_queue").update({ claimed_at: new Date(Date.now() + 5_000).toISOString() }).eq("id", q2); } }, Deadline.none());
    expect(r2.cancelled).toBe(1);
    expect(m).toBe(1);
    expect((await queueRow(q2)).status).toBe("claimed");                 // the other worker's claim is untouched
  });

  it("max retries fail the job; devices that already succeeded are never sent again", async () => {
    const { subs, queueId } = await queuedPush("pd6", 2);
    const bad = subs[1];
    const sends: string[] = [];
    const send = async (s: { id: string }) => { sends.push(s.id); if (s.id === bad) throw Object.assign(new Error("flaky"), { statusCode: 500 }); };
    for (let attempt = 1; attempt <= 3; attempt++) {
      await makeDue(queueId);
      const r = await sendFriendMessagePushes(10, { configured: true, send }, Deadline.none());
      const row = await queueRow(queueId);
      if (attempt < 3) { expect(r.retried).toBe(1); expect(row).toMatchObject({ status: "queued", attempts: attempt }); }
      else { expect(r.failed).toBe(1); expect(row).toMatchObject({ status: "failed", attempts: 3 }); }
      expect((row.deliveries as Record<string, { status: string }>)[subs[0]].status).toBe("sent");
    }
    expect(sends.filter((s) => s === subs[0])).toHaveLength(1);        // sent once, then skipped
    expect(sends.filter((s) => s === bad)).toHaveLength(3);
  });
});
