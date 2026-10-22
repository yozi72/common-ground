// Items 9 and 11: consent events describe the actual action and stay private;
// friend-request flags only while active; resolved invitations are purged;
// the lobby matching throttle is shared (database) and failures are recorded.
import { describe, it, expect, afterAll } from "vitest";
import { generateNextQuestion } from "@/lib/workers/questions";
import { runMatchingObserved } from "@/lib/workers/matching";
import { admin, makeUser, deleteUser, openSessionNow, openConversation, finishOpeningRound, resetQueue, LEFT, RIGHT, type TestUser } from "./helpers";

const made: TestUser[] = [];
afterAll(async () => { for (const u of made.splice(0)) await deleteUser(u); });
async function keepTalking(tag: string) {
  await openSessionNow(); await resetQueue();
  const a = await makeUser(`${tag}-a`, LEFT); const b = await makeUser(`${tag}-b`, RIGHT); made.push(a, b);
  const conv = await openConversation(a, b);
  await finishOpeningRound(a, b, conv, generateNextQuestion);
  await a.client.rpc("leave_conversation", { p_conversation: conv });
  await a.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
  await b.client.rpc("set_connection_decision", { p_conversation: conv, p_decision: true });
  const { data: conns } = await a.client.rpc("friend_threads_overview");
  const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: conns![0].connection_id });
  return { a, b, conv, connectionId: conns![0].connection_id as string, tid: tid as string };
}
const events = async (u: TestUser) => ((await admin().from("consent_events").select("kind, granted").eq("account_id", u.id).like("kind", "contact_sharing%").order("created_at")).data ?? []).map((e) => `${e.kind}:${e.granted}`);
const overview = async (u: TestUser) => (await u.client.rpc("friend_threads_overview")).data![0];

describe("consent events describe the actual action", () => {
  it("request, decline (private), re-request after cooldown, accept (activation), withdrawal and ending", async () => {
    const { a, b, connectionId } = await keepTalking("ce1");
    expect(await events(a)).toEqual([]);
    await a.client.rpc("request_friend", { p_connection: connectionId });
    expect(await events(a)).toEqual(["contact_sharing_request:true"]);
    expect(await events(b)).toEqual([]);
    const requesterView = await overview(a);
    await b.client.rpc("respond_friend_request", { p_connection: connectionId, p_accept: false });
    expect(await events(b)).toEqual(["contact_sharing_response:false"]);          // the responder declined someone else's request
    expect(await events(a)).toEqual(["contact_sharing_request:true"]);              // nothing new for the requester
    expect(await overview(a)).toEqual(requesterView);                               // and nothing visible changed
    // the requester cannot read the responder's events (RLS: own rows only)
    expect((await a.client.from("consent_events").select("kind").eq("account_id", b.id)).data).toEqual([]);
    // cooldown over: a asks again, b accepts
    await admin().from("connections").update({ friend_requested_at: new Date(Date.now() - 8 * 86400_000).toISOString() }).eq("id", connectionId);
    await a.client.rpc("request_friend", { p_connection: connectionId });
    expect((await b.client.rpc("respond_friend_request", { p_connection: connectionId, p_accept: true })).data).toBe("friends");
    // rows written in one statement share created_at, so compare as sets
    expect((await events(b)).sort()).toEqual(["contact_sharing:true", "contact_sharing_response:false", "contact_sharing_response:true"]);
    expect((await events(a)).sort()).toEqual(["contact_sharing:true", "contact_sharing_request:true", "contact_sharing_request:true"]);
    // withdrawal by the one who ends the friendship; "ended" for the other person
    await a.client.rpc("remove_friend", { p_connection: connectionId });
    expect((await events(a)).at(-1)).toBe("contact_sharing:false");
    expect((await events(b)).at(-1)).toBe("contact_sharing_ended:false");
    // a block on a friends-tier pair records the same; on a chat-tier pair it records nothing about contact sharing
    const { a: c, b: d, connectionId: cid2, tid: tid2 } = await keepTalking("ce2");
    await c.client.rpc("request_friend", { p_connection: cid2 });
    await d.client.rpc("respond_friend_request", { p_connection: cid2, p_accept: true });
    await d.client.rpc("block_peer", { p_conversation: tid2 });
    expect((await events(d)).at(-1)).toBe("contact_sharing:false");
    expect((await events(c)).at(-1)).toBe("contact_sharing_ended:false");
    const { a: e, b: f, tid: tid3 } = await keepTalking("ce3");
    await f.client.rpc("block_peer", { p_conversation: tid3 });
    expect(await events(e)).toEqual([]); expect(await events(f)).toEqual([]);
  });
});

describe("friend-request flags, invitation retention, shared matching throttle", () => {
  it("request flags are actionable only while the relationship is active and unblocked", async () => {
    const { a, b, connectionId } = await keepTalking("ff1");
    await a.client.rpc("request_friend", { p_connection: connectionId });
    expect(await overview(b)).toMatchObject({ request_for_me: true });
    expect(await overview(a)).toMatchObject({ request_from_me: true });
    await b.client.rpc("remove_friend", { p_connection: connectionId });
    expect(await overview(b)).toMatchObject({ status: "ended", request_for_me: false, request_available: false });
    expect(await overview(a)).toMatchObject({ request_from_me: false });
    expect((await b.client.rpc("respond_friend_request", { p_connection: connectionId, p_accept: true })).error?.code).toBe("P0001");
    const { a: c, b: d, connectionId: cid2, tid: tid2 } = await keepTalking("ff2");
    await c.client.rpc("request_friend", { p_connection: cid2 });
    await d.client.rpc("block_peer", { p_conversation: tid2 });
    expect(await overview(d)).toMatchObject({ request_for_me: false });
  });

  it("resolved invitations are purged after the queue retention window; pending ones and open conversations are untouched", async () => {
    await openSessionNow(); await resetQueue();
    const a = await makeUser("ir-a", LEFT); const b = await makeUser("ir-b", RIGHT); made.push(a, b);
    const conv = await openConversation(a, b);
    const { data: c } = await admin().from("conversations").select("invitation_id").eq("id", conv).single();
    const inv = c!.invitation_id as string;
    expect(inv).toBeTruthy();
    await admin().from("match_invitations").update({ resolved_at: new Date(Date.now() - 100 * 86400_000).toISOString(), created_at: new Date(Date.now() - 100 * 86400_000).toISOString() }).eq("id", inv);
    const { data: n } = await admin().rpc("purge_retention");
    expect(n.invitations).toBeGreaterThanOrEqual(1);
    expect((await admin().from("match_invitations").select("id").eq("id", inv)).data).toEqual([]);
    expect((await admin().from("conversations").select("status, invitation_id").eq("id", conv).single()).data).toMatchObject({ status: "opening", invitation_id: null });
    // a pending invitation of any age is never purged
    const { data: keep } = await admin().from("match_invitations").insert({ kind: "match", status: "pending", expires_at: new Date(Date.now() + 60_000).toISOString(), created_at: new Date(Date.now() - 100 * 86400_000).toISOString() }).select("id").single();
    await admin().rpc("purge_retention");
    expect((await admin().from("match_invitations").select("id").eq("id", keep!.id)).data).toHaveLength(1);
    await admin().from("match_invitations").delete().eq("id", keep!.id);
  });

  it("the lobby matching throttle is held in the database and failures are recorded as metric events", async () => {
    await admin().from("worker_state").delete().eq("key", "last_matching_run");
    expect((await runMatchingObserved("test", { minIntervalSeconds: 10 })).pairs).not.toBeNull();   // ran
    expect((await runMatchingObserved("test", { minIntervalSeconds: 10 })).pairs).toBeNull();       // throttled (any instance)
    await admin().from("worker_state").update({ at: new Date(Date.now() - 11_000).toISOString() }).eq("key", "last_matching_run");
    expect((await runMatchingObserved("test", { minIntervalSeconds: 10 })).pairs).not.toBeNull();   // due again
    expect((await admin().rpc("run_matching_if_due", { p_min_seconds: 10 })).data).toBeNull();
    // a failure: an interval outside the integer range makes the RPC itself fail
    const before = (await admin().from("metric_events").select("id", { count: "exact", head: true }).eq("kind", "matching_failed")).count ?? 0;
    const bad = await runMatchingObserved("test-bad", { minIntervalSeconds: 2 ** 31 });
    expect(bad.error).toBeTruthy();
    expect(bad.pairs).toBeNull();
    const after = (await admin().from("metric_events").select("id", { count: "exact", head: true }).eq("kind", "matching_failed")).count ?? 0;
    expect(after).toBe(before + 1);
  });
});
