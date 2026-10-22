// Connection semantics end to end: my_recent_conversations rows for each state,
// the pure helpers every consumer uses, and the rendered Chats list / reflection
// card (react-dom/server) so the UI assertions are real markup, not assumptions.
import { describe, it, expect, vi, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeUser, deleteUser, openSessionNow, openConversation, resetQueue, LEFT, RIGHT, MIXED, type TestUser } from "./helpers";
import { undecidedRecent, reflectConnection, type RecentRow } from "@/lib/connection-state";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }), redirect: () => undefined, notFound: () => undefined }));
vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ rpc: async () => ({ data: [], error: null }), channel: () => ({ on: () => ({ subscribe: () => ({}) }) }), removeChannel: () => undefined }) }));

const { Connections } = await import("@/app/connections/Connections");
const { Reflect } = await import("@/app/c/[id]/reflect/Reflect");

type Full = RecentRow & { ended_at: string; end_reason: string | null; questions_asked: number; reflection_done: boolean };
const recentFor = async (u: TestUser) => ((await u.client.rpc("my_recent_conversations")).data ?? []) as Full[];
const row = (rows: Full[], conv: string) => rows.find((r) => r.conversation_id === conv)!;
const chats = (rows: Full[], threads: unknown[] = []) => renderToStaticMarkup(<Connections initialThreads={threads as never} initialRecent={rows} />);
const reflect = (r: Full | undefined, decision: boolean | null) =>
  renderToStaticMarkup(<Reflect conversationId={r?.conversation_id ?? "x"} peerAlias="Partner" endReason="left" questionsAsked={3} initialReflection={null} initialDecision={decision} friendshipEnabled initialConnection={reflectConnection(r)} />);

const made: TestUser[] = [];
afterAll(async () => { for (const u of made.splice(0)) await deleteUser(u); });

describe("connection semantics in every consumer", () => {
  it("initial connection, rematch, one-sided, ended, restored and blocked states render the right thing", async () => {
    await openSessionNow(); await resetQueue();
    const a = await makeUser("cs-a", LEFT); const b = await makeUser("cs-b", RIGHT); made.push(a, b);

    // --- one-sided decision: a said yes, b undecided
    const conv1 = await openConversation(a, b);
    await a.client.rpc("leave_conversation", { p_conversation: conv1 });
    await a.client.rpc("set_connection_decision", { p_conversation: conv1, p_decision: true });
    let ra = await recentFor(a); let rb = await recentFor(b);
    expect(row(ra, conv1)).toMatchObject({ my_decision: true, both_yes: false, connected: false });
    expect(row(rb, conv1)).toMatchObject({ my_decision: null, both_yes: false, connected: false });
    expect(undecidedRecent(ra)).toEqual([]);                                   // a decided
    expect(undecidedRecent(rb).map((r) => r.conversation_id)).toEqual([conv1]); // b is nudged
    expect(chats(ra)).toContain("You said yes, waiting for them.");
    expect(chats(rb)).toContain("Decide &amp; reflect");
    expect(reflect(row(rb, conv1), null)).toContain("Yes, keep talking");
    expect(reflect(row(ra, conv1), true)).toContain("If they also say yes");

    // --- initial connection: both yes here
    await b.client.rpc("set_connection_decision", { p_conversation: conv1, p_decision: true });
    ra = await recentFor(a);
    expect(row(ra, conv1)).toMatchObject({ both_yes: true, connected: true });
    expect(row(ra, conv1).connection_id).toBeTruthy();
    expect(chats(ra)).not.toContain("Decide &amp; reflect");                   // shown as a chat, not as something to decide
    expect(reflect(row(ra, conv1), true)).toContain("You both said yes");
    expect(reflect(row(ra, conv1), true)).toContain("Open chat");
    const { data: tid } = await a.client.rpc("open_friend_thread", { p_connection: row(ra, conv1).connection_id });

    // --- rematch: a second live conversation with the same person while the chat is active
    const conv2 = await openConversation(a, b);
    await b.client.rpc("leave_conversation", { p_conversation: conv2 });
    ra = await recentFor(a); rb = await recentFor(b);
    expect(row(ra, conv2)).toMatchObject({ my_decision: null, both_yes: false, connected: true, thread_id: tid });
    expect(undecidedRecent(ra)).toEqual([]);                                   // no nudge: nothing to decide
    const html = chats(ra);
    expect(html).toContain("Met again");
    expect(html).toContain("You already chat with");
    expect(html).toContain("Open chat");
    expect(html).not.toContain("Decide &amp; reflect");
    const rhtml = reflect(row(ra, conv2), null);
    expect(rhtml).toContain("already chat with Partner from an earlier conversation");
    expect(rhtml).toContain("Open chat");
    expect(rhtml).not.toContain("Yes, keep talking");
    expect(rhtml).not.toContain("No thanks");
    // the server would reject the refusal the old UI offered
    expect((await a.client.rpc("set_connection_decision", { p_conversation: conv2, p_decision: false })).error?.code).toBe("P0001");
    expect((await a.client.rpc("set_connection_decision", { p_conversation: conv2, p_decision: true })).data).toMatchObject({ status: "connected" });

    // --- ended connection: consents revoked, both conversations are open to a fresh decision
    await a.client.rpc("remove_friend", { p_connection: row(ra, conv1).connection_id });
    ra = await recentFor(a); rb = await recentFor(b);
    for (const c of [conv1, conv2]) {
      expect(row(ra, c)).toMatchObject({ my_decision: null, both_yes: false, connected: false });
      expect(row(rb, c)).toMatchObject({ my_decision: null, both_yes: false, connected: false });
    }
    expect(undecidedRecent(ra).map((r) => r.conversation_id).sort()).toEqual([conv1, conv2].sort());
    expect(chats(ra)).toContain("Decide &amp; reflect");
    expect(chats(ra)).not.toContain("Met again");
    expect(reflect(row(ra, conv2), null)).toContain("Yes, keep talking");

    // --- restored connection: fresh mutual yes on conv2 brings the same connection back
    await a.client.rpc("set_connection_decision", { p_conversation: conv2, p_decision: true });
    await b.client.rpc("set_connection_decision", { p_conversation: conv2, p_decision: true });
    ra = await recentFor(a);
    expect(row(ra, conv2)).toMatchObject({ both_yes: true, connected: true });
    expect(row(ra, conv1)).toMatchObject({ both_yes: false, connected: true });   // the earlier conversation now points at the restored chat
    expect(row(ra, conv1).connection_id).toBe(row(ra, conv2).connection_id);
    expect(chats(ra)).toContain("Met again");
    expect(undecidedRecent(ra)).toEqual([]);

    // --- blocked pair: nothing listed, nothing to render
    const e = await makeUser("cs-e", MIXED); made.push(e);
    const conv3 = await openConversation(a, e);
    await e.client.rpc("block_peer", { p_conversation: conv3 });
    ra = await recentFor(a);
    expect(ra.some((r) => r.conversation_id === conv3)).toBe(false);
    expect(reflectConnection(undefined)).toBeNull();
    expect(chats([])).toContain("Nothing here yet");
  });
});
