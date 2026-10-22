// Items 7 and 8: appeal eligibility survives ending, blocking, leaving, removal
// and clearing without delivering anything into a closed conversation; and the
// lock order is verified with COORDINATED Postgres transactions (one holds the
// conversation lock while the other tries to resolve an appeal), not just
// unsynchronized Promise.all runs.
import { describe, it, expect, afterAll } from "vitest";
import { processPendingBatch } from "@/lib/workers/moderation";
import { generateNextQuestion } from "@/lib/workers/questions";
import { admin, makeUser, deleteUser, openSessionNow, openConversation, finishOpeningRound, resetQueue, LEFT, RIGHT, type TestUser } from "./helpers";
import { pgClient } from "./pg";

const made: TestUser[] = [];
afterAll(async () => { for (const u of made.splice(0)) await deleteUser(u); });
const AUTO = { p_categories: [], p_user_explanation: null, p_suggested_revision: null, p_confidence: 0.9, p_detector_hits: [], p_provider: "mock", p_model: "mock", p_raw_valid: true, p_latency_ms: 5 };

async function chattingPair(tag: string) {
  await openSessionNow(); await resetQueue();
  const a = await makeUser(`${tag}-a`, LEFT); const b = await makeUser(`${tag}-b`, RIGHT); made.push(a, b);
  const conv = await openConversation(a, b);
  expect(await finishOpeningRound(a, b, conv, generateNextQuestion)).toBe("chatting");
  return { a, b, conv };
}
async function keepTalking(tag: string) {
  const { a, b, conv } = await chattingPair(tag);
  await a.client.rpc("leave_conversation", { p_conversation: conv });
  await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
  await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
  const { data: conns } = await a.client.rpc("friend_threads_overview");
  const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
  return { a, b, conv, connectionId: conns![0].connection_id as string, tid: tid as string };
}
// a held (revise) message from `u` in `conv`, decided by the mock moderator
async function heldMessage(u: TestUser, conv: string, id: string, body = "my number is 415 555 0199") {
  const { data: pid, error } = await u.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: id, p_body: body });
  expect(error).toBeNull();
  await processPendingBatch();
  return pid as string;
}
const pending = async (id: string) => (await admin().from("pending_messages").select("status, undeliverable_reason, user_explanation").eq("id", id).single()).data!;
const delivered = async (conv: string) => (await admin().from("approved_messages").select("id").eq("conversation_id", conv)).data!;

describe("appeal eligibility is separate from deliverability", () => {
  it("leaving keeps the revise decision appealable; the revision can no longer be sent; an overturn records the outcome without delivering", async () => {
    const { a, b, conv } = await chattingPair("ap1");
    const pid = await heldMessage(a, conv, "ap1-1");
    expect((await pending(pid)).status).toBe("revise");
    await b.client.rpc("leave_conversation", { p_conversation: conv });
    expect(await pending(pid)).toMatchObject({ status: "revise", undeliverable_reason: "left" });
    expect((await a.client.rpc("accept_revision", { p_pending: pid })).error?.message).toMatch(/no longer be delivered/);
    const { data: appeal, error } = await a.client.rpc("file_appeal", { p_pending: pid, p_note: "it was fine" });
    expect(error).toBeNull();
    const { data: r } = await admin().rpc("resolve_appeal", { p_appeal: appeal, p_status: "overturned", p_note: null, p_resolver: null });
    expect(r).toMatchObject({ delivered: false, reason: "left", pending_id: pid });
    const after = await pending(pid);
    expect(after.status).toBe("cancelled");
    expect(after.user_explanation).toMatch(/accepted your appeal, but the message could not be delivered because the conversation ended/);
    expect(await delivered(conv)).toHaveLength(0);
    expect((await admin().from("appeals").select("status").eq("id", appeal).single()).data!.status).toBe("overturned");
  });

  it("a block keeps a blocked decision appealable; ending (abandon) and removal do the same; nothing is delivered", async () => {
    const { a, b, conv } = await chattingPair("ap2");
    const pid = await heldMessage(a, conv, "ap2-1", "kill yourself");
    expect((await pending(pid)).status).toBe("blocked");
    await b.client.rpc("block_peer", { p_conversation: conv });
    expect(await pending(pid)).toMatchObject({ status: "blocked", undeliverable_reason: "blocked" });
    const { data: appeal, error } = await a.client.rpc("file_appeal", { p_pending: pid, p_note: "" });
    expect(error).toBeNull();
    expect((await admin().rpc("resolve_appeal", { p_appeal: appeal, p_status: "overturned", p_note: null, p_resolver: null })).data).toMatchObject({ delivered: false, reason: "blocked" });
    expect(await delivered(conv)).toHaveLength(0);
    // abandonment (the scheduler's end) and a friend removal mark rows the same way
    const { a: c, b: d, conv: conv2 } = await chattingPair("ap3");
    const pid2 = await heldMessage(c, conv2, "ap3-1");
    await admin().rpc("end_conversation", { p_conversation: conv2, p_reason: "abandoned" });
    expect(await pending(pid2)).toMatchObject({ status: "revise", undeliverable_reason: "abandoned" });
    expect((await c.client.rpc("file_appeal", { p_pending: pid2, p_note: "" })).error).toBeNull();
    void d;
    const { a: e, b: f, connectionId, tid } = await keepTalking("ap4");
    const pid3 = await heldMessage(e, tid, "ap4-1");
    await f.client.rpc("remove_friend", { p_connection: connectionId });
    expect(await pending(pid3)).toMatchObject({ status: "revise", undeliverable_reason: "unfriended" });
    expect((await e.client.rpc("file_appeal", { p_pending: pid3, p_note: "" })).error).toBeNull();
  });

  it("clearing keeps my own decided rows appealable, cancels my undecided ones, never touches the other person's; delivery after a clear is refused", async () => {
    const { a, b, tid } = await keepTalking("ap5");
    const mine = await heldMessage(a, tid, "ap5-1");
    const { data: minePending } = await a.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "ap5-2", p_body: "still checking" });
    const { data: theirs } = await b.client.rpc("submit_message", { p_conversation: tid, p_client_send_id: "ap5-3", p_body: "from the other side" });
    await a.client.rpc("clear_thread_history", { p_conversation: tid });
    expect(await pending(mine)).toMatchObject({ status: "revise", undeliverable_reason: "cleared" });
    expect(await pending(minePending as string)).toMatchObject({ status: "cancelled", undeliverable_reason: "cleared" });
    expect((await pending(theirs as string)).status).toBe("pending");                     // the other person's submission is not mine to cancel
    await processPendingBatch();                                                           // ...but it was written before the clear, so delivery refuses it
    expect((await pending(theirs as string)).status).toBe("cancelled");
    expect(await delivered(tid)).toHaveLength(0);
    const { data: appeal } = await a.client.rpc("file_appeal", { p_pending: mine, p_note: "" });
    expect((await admin().rpc("resolve_appeal", { p_appeal: appeal, p_status: "overturned", p_note: null, p_resolver: null })).data).toMatchObject({ delivered: false, reason: "cleared" });
    expect(await delivered(tid)).toHaveLength(0);
  });

  it("retention keeps an appealed undeliverable row until the appeal is resolved; a live overturn still delivers", async () => {
    const { a, b, conv } = await chattingPair("ap6");
    const pid = await heldMessage(a, conv, "ap6-1");
    const { data: appeal } = await a.client.rpc("file_appeal", { p_pending: pid, p_note: "" });
    await b.client.rpc("leave_conversation", { p_conversation: conv });
    await admin().from("pending_messages").update({ updated_at: new Date(Date.now() - 400 * 86400_000).toISOString() }).eq("id", pid);
    await admin().rpc("purge_retention");
    expect((await admin().from("pending_messages").select("id").eq("id", pid)).data).toHaveLength(1);   // open appeal: kept
    await admin().rpc("resolve_appeal", { p_appeal: appeal, p_status: "upheld", p_note: "stands", p_resolver: null });
    await admin().from("pending_messages").update({ updated_at: new Date(Date.now() - 400 * 86400_000).toISOString() }).eq("id", pid);
    await admin().rpc("purge_retention");
    expect((await admin().from("pending_messages").select("id").eq("id", pid)).data).toHaveLength(0);
    // the ordinary path is unchanged: an overturn in a live conversation delivers
    const { a: c, conv: conv2 } = await chattingPair("ap7");
    const pid2 = await heldMessage(c, conv2, "ap7-1");
    const { data: appeal2 } = await c.client.rpc("file_appeal", { p_pending: pid2, p_note: "" });
    expect((await admin().rpc("resolve_appeal", { p_appeal: appeal2, p_status: "overturned", p_note: null, p_resolver: null })).data).toMatchObject({ delivered: true });
    expect(await delivered(conv2)).toHaveLength(1);
    expect((await pending(pid2)).status).toBe("approved");
  });
});

describe("lock order under coordinated interleavings (real Postgres transactions)", () => {
  // T1 holds the conversation lock (the position of end/clear/delivery at step 3).
  // T2 then tries to resolve an appeal. With the old order T2 would lock the
  // pending row first and then wait for the conversation; T1's end_conversation
  // would then wait for the pending row: a deadlock. Now T2 waits on the
  // conversation lock holding nothing, so T1 completes first.
  async function waitingOnLock(pid: number) {
    const c = await pgClient();
    try {
      for (let i = 0; i < 40; i++) {
        const r = await c.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
        if (r.rows[0]?.wait_event_type === "Lock") return true;
        await new Promise((res) => setTimeout(res, 50));
      }
      return false;
    } finally { await c.end(); }
  }
  const asUser = (uid: string) => `select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`;

  it("overturning an appealed revision while the sender's partner ends the conversation: no deadlock, nothing delivered", async () => {
    const { a, b, conv } = await chattingPair("lk1");
    const pid = await heldMessage(a, conv, "lk1-1");
    const { data: appeal } = await a.client.rpc("file_appeal", { p_pending: pid, p_note: "" });
    const t1 = await pgClient(); const t2 = await pgClient();
    try {
      await t1.query("begin");
      await t1.query("select id from public.conversations where id = $1 for no key update", [conv]);
      const t2pid = (await t2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      await t2.query("begin");
      const resolving = t2.query("select public.resolve_appeal($1, 'overturned', null, null) as r", [appeal]);
      expect(await waitingOnLock(t2pid)).toBe(true);                                    // T2 is blocked on the conversation, holding nothing
      await t1.query(asUser(b.id));
      await t1.query("select public.leave_conversation($1)", [conv]);                   // would deadlock (40P01) under the old order
      await t1.query("commit");
      const r = (await resolving).rows[0].r;
      await t2.query("commit");
      expect(r).toMatchObject({ delivered: false, reason: "left" });
      expect((await pending(pid)).status).toBe("cancelled");
      expect(await delivered(conv)).toHaveLength(0);
    } finally { await t1.end(); await t2.end(); }
  });

  it("overturning an appealed revision while the sender clears the chat: no deadlock, nothing delivered", async () => {
    const { a, tid } = await keepTalking("lk2");
    const pid = await heldMessage(a, tid, "lk2-1");
    const { data: appeal } = await a.client.rpc("file_appeal", { p_pending: pid, p_note: "" });
    const t1 = await pgClient(); const t2 = await pgClient();
    try {
      await t1.query("begin");
      await t1.query("select id from public.conversations where id = $1 for no key update", [tid]);
      const t2pid = (await t2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      await t2.query("begin");
      const resolving = t2.query("select public.resolve_appeal($1, 'overturned', null, null) as r", [appeal]);
      expect(await waitingOnLock(t2pid)).toBe(true);
      await t1.query(asUser(a.id));
      await t1.query("select public.clear_thread_history($1)", [tid]);
      await t1.query("commit");
      const r = (await resolving).rows[0].r;
      await t2.query("commit");
      expect(r).toMatchObject({ delivered: false, reason: "cleared" });
      expect(await delivered(tid)).toHaveLength(0);
    } finally { await t1.end(); await t2.end(); }
  });

  it("worker delivery and appeal resolution in the same conversation serialize on the conversation lock", async () => {
    const { a, b, conv } = await chattingPair("lk3");
    for (let i = 0; i < 4; i++) {
      const held = await heldMessage(a, conv, `lk3-h${i}`);
      const { data: appeal } = await a.client.rpc("file_appeal", { p_pending: held, p_note: "" });
      const { data: fresh } = await b.client.rpc("submit_message", { p_conversation: conv, p_client_send_id: `lk3-f${i}`, p_body: "plain words" });
      const { data: claimed } = await admin().rpc("claim_pending", { p_limit: 10 });
      const token = claimed!.find((r: { id: string }) => r.id === fresh)!.claim_token as string;
      const [x, y] = await Promise.all([
        admin().rpc("apply_moderation_decision", { p_pending: fresh, p_decision: "allow", ...AUTO, p_claim_token: token }),
        admin().rpc("resolve_appeal", { p_appeal: appeal, p_status: "overturned", p_note: null, p_resolver: null }),
      ]);
      expect(x.error, "apply").toBeNull(); expect(y.error, "resolve").toBeNull();
      expect(y.data).toMatchObject({ delivered: true });
    }
    expect(await delivered(conv)).toHaveLength(8);
  });
});
