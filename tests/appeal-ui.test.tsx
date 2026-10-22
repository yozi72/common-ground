// Shared appeal controls: the pure form state machine, the polling helpers and
// the rendered HeldItem in open and ended chats (react-dom/server).
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { appealFormInitial, appealFormReducer, fastPollDue, heldNeedsRefresh, type HeldMessage } from "@/lib/held-messages";

vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ rpc: async () => ({ data: [], error: null }) }) }));
const { HeldItem } = await import("@/components/HeldMessages");

const base: HeldMessage = { id: "m1", kind: "chat", body: "my number is 415 555 0199", status: "revise", user_explanation: "contains a phone number", suggested_revision: "my number is [number removed]", undeliverable_reason: null, created_at: new Date().toISOString(), appeal_id: null, appeal_status: null, appeal_note: null, appeal_resolution_note: null, appeal_created_at: null, appeal_resolved_at: null };
const render = (m: HeldMessage, open: boolean) => renderToStaticMarkup(<ul><HeldItem m={m} open={open} onChanged={() => undefined} /></ul>);

describe("appeal form state", () => {
  it("shows success only after acceptance, keeps the note on failure, allows a retry and never double-submits", () => {
    let s = appealFormReducer(appealFormInitial, { type: "open" });
    s = appealFormReducer(s, { type: "note", note: "it was my own number" });
    s = appealFormReducer(s, { type: "submit" });
    expect(s.phase).toBe("sending");
    expect(appealFormReducer(s, { type: "submit" })).toBe(s);                       // a second tap while sending changes nothing
    expect(appealFormReducer(s, { type: "note", note: "x" })).toBe(s);
    const failed = appealFormReducer(s, { type: "failed", error: "Something went wrong" });
    expect(failed).toMatchObject({ phase: "error", note: "it was my own number", error: "Something went wrong" });   // not "sent"; note kept
    const retry = appealFormReducer(failed, { type: "submit" });
    expect(retry.phase).toBe("sending");
    const sent = appealFormReducer(retry, { type: "accepted" });
    expect(sent).toMatchObject({ phase: "sent", note: "it was my own number", error: null });
    expect(appealFormReducer(sent, { type: "submit" })).toBe(sent);                 // nothing after success either
    expect(appealFormReducer(sent, { type: "open" })).toBe(sent);
    expect(appealFormReducer(appealFormInitial, { type: "accepted" })).toBe(appealFormInitial);   // a stray acceptance outside sending is ignored
  });
});

describe("polling helpers", () => {
  const now = Date.parse("2026-10-22T20:00:00Z");
  it("fast polling only for actively checked messages, not for budget-deferred ones, with the transition back", () => {
    const live = { status: "pending", next_attempt_at: null };
    const soon = { status: "pending", next_attempt_at: new Date(now + 20_000).toISOString() };
    const deferred = { status: "pending", next_attempt_at: new Date(now + 6 * 3600_000).toISOString() };   // waits for the daily reset
    expect(fastPollDue([deferred], now)).toBe(false);
    expect(fastPollDue([live], now)).toBe(true);
    expect(fastPollDue([soon], now)).toBe(true);
    expect(fastPollDue([deferred, live], now)).toBe(true);
    expect(fastPollDue([{ status: "revise", next_attempt_at: null }], now)).toBe(false);
    expect(fastPollDue([deferred], now + 6 * 3600_000 - 30_000)).toBe(true);        // eligible again soon → fast polling resumes
    expect(fastPollDue([], now)).toBe(false);
  });
  it("held outcomes refresh only while an appeal is open", () => {
    expect(heldNeedsRefresh([base])).toBe(false);
    expect(heldNeedsRefresh([{ ...base, appeal_id: "a", appeal_status: "open" }])).toBe(true);
    expect(heldNeedsRefresh([{ ...base, appeal_id: "a", appeal_status: "upheld" }])).toBe(false);
  });
});

describe("HeldItem rendering", () => {
  it("open chat: deliverable revision offers the rewording and Appeal; ended chat: no rewording, record-only copy", () => {
    const open = render(base, true);
    expect(open).toContain("Send this version");
    expect(open).toContain("Appeal");
    expect(open).not.toContain("for the record");
    const ended = render({ ...base, undeliverable_reason: "left" }, false);
    expect(ended).not.toContain("Send this version");
    expect(ended).toContain("This conversation has ended, so this can&#x27;t be sent now. You can still appeal the decision for the record.");   // React escapes the apostrophe
  });
  it("persisted appeal states render without any client-side flag: open, upheld, overturned (delivered / not)", () => {
    const openAppeal = render({ ...base, appeal_id: "a", appeal_status: "open", appeal_note: "please" }, true);
    expect(openAppeal).toContain("Appeal sent");
    expect(openAppeal).toContain("Your note: “please”");
    expect(openAppeal).not.toContain(">Appeal<");                                    // no second appeal offered after a reload
    const upheld = render({ ...base, status: "blocked", appeal_id: "a", appeal_status: "upheld", appeal_resolution_note: "stands" }, false);
    expect(upheld).toContain("the decision stands");
    expect(upheld).toContain("Reviewer: stands");
    const overturnedUndeliverable = render({ ...base, status: "cancelled", undeliverable_reason: "cleared", user_explanation: "A reviewer accepted your appeal, but the message could not be delivered because the chat's history was cleared.", appeal_id: "a", appeal_status: "overturned" }, true);
    expect(overturnedUndeliverable).toContain("history was cleared");
    expect(overturnedUndeliverable).not.toContain("Send this version");
    const overturnedDelivered = render({ ...base, status: "approved", appeal_id: "a", appeal_status: "overturned" }, true);
    expect(overturnedDelivered).toContain("the message was delivered");
  });
});
