"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sprout, Bridge } from "@/components/Illustrations";
import { HeldMessages } from "@/components/HeldMessages";
import type { HeldMessage } from "@/lib/held-messages";

type Reflection = { felt_understood: number | null; recognized_shared: number | null; would_repeat: boolean | null; free_text: string | null };

// The keep-talking decision comes first: it is the one thing that is lost if
// someone leaves early. The reflection questions follow and are optional.
export function Reflect({ conversationId, peerAlias, endReason, questionsAsked, initialReflection, initialDecision, friendshipEnabled, initialConnection = null, initialHeld = null }: {
  conversationId: string; peerAlias: string; endReason: string | null; questionsAsked: number;
  initialReflection: Reflection | null; initialDecision: boolean | null; friendshipEnabled: boolean;
  initialConnection?: { connectionId: string; threadId: string | null; fromThisConversation?: boolean } | null;
  initialHeld?: HeldMessage[] | null;
}) {
  const router = useRouter();
  const [understood, setUnderstood] = useState(initialReflection?.felt_understood ?? 0);
  const [shared, setShared] = useState(initialReflection?.recognized_shared ?? 0);
  const [repeat, setRepeat] = useState<boolean | null>(initialReflection?.would_repeat ?? null);
  const [text, setText] = useState(initialReflection?.free_text ?? "");
  const [saved, setSaved] = useState(!!initialReflection);
  const [decision, setDecision] = useState<boolean | null>(initialDecision);
  const [connection, setConnection] = useState(initialConnection);
  const [ending, setEnding] = useState(false);
  const connected = !!connection;
  const [error, setError] = useState<string | null>(null);
  const blocked = endReason === "blocked";

  async function post(body: unknown) {
    setError(null);
    const res = await fetch(`/api/conversations/${conversationId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { setError(json.error ?? "Something went wrong"); return null; }
    return json;
  }

  async function saveReflection() {
    const r = await post({ action: "reflection", felt_understood: understood || undefined, recognized_shared: shared || undefined, would_repeat: repeat ?? undefined, free_text: text || undefined });
    if (r) setSaved(true);
  }
  async function decide(d: boolean) {
    const r = await post({ action: "connection_decision", decision: d });
    if (r) { setDecision(d); if (r.status === "connected") setConnection({ connectionId: r.connection_id, threadId: connection?.threadId ?? null, fromThisConversation: true }); }
  }
  async function openChat() {
    if (!connection) return;
    const res = await fetch(`/api/connections/${connection.connectionId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "open" }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { setError(json.error ?? "Something went wrong"); return; }
    router.push(`/c/${json.conversation_id}`);
  }
  async function endChat() {
    if (!connection) return;
    const res = await fetch(`/api/connections/${connection.connectionId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove" }) });
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? "Something went wrong"); return; }
    setConnection(null); setDecision(null); setEnding(false);
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <Sprout className="w-40 h-auto mx-auto float" />
        <h1 className="text-3xl font-semibold">That conversation has ended</h1>
        <p className="muted text-sm mt-1">
          {endReason === "left" && "One of you left."}{endReason === "abandoned" && "One of you was away too long."}{endReason === "blocked" && "It was ended with a block."}{!endReason && "Thanks for taking part."}
          {" "}{questionsAsked > 0 && `You went through ${questionsAsked} question${questionsAsked === 1 ? "" : "s"}.`}
        </p>
      </div>
      {error && <div className="notice notice-bad" role="alert">{error}</div>}

      {friendshipEnabled && !blocked && (
        <section className="card space-y-3" style={{ borderColor: "var(--accent)" }}>
          <Bridge className="w-32 h-auto mx-auto" />
          <h2 className="font-semibold text-xl text-center">Keep talking with {peerAlias}?</h2>
          <p className="muted text-sm">Your answer is private. If you both say yes, you both find out and get a chat under Chats that works any time, still under your aliases, still checked before delivery, and still without contact details unless you later both choose to become friends. If only one of you says yes, neither of you is told. You can come back to this from the Chats tab for 30 days.</p>
          {connected ? (
            <div className="space-y-2">
              <div className="notice notice-ok" role="status">
                {connection?.fromThisConversation === false
                  ? <>You already chat with {peerAlias} from an earlier conversation, so there is nothing to decide here. The chat is under <Link className="underline" href="/connections">Chats</Link>.</>
                  : <>You both said yes. The chat with {peerAlias} is under <Link className="underline" href="/connections">Chats</Link>.</>}
              </div>
              {ending ? (
                <div className="notice notice-warn space-y-2 text-sm" role="alertdialog">
                  <p>End this chat with {peerAlias}? Messaging stops for both of you. What&apos;s there stays readable for 30 days, then it&apos;s deleted. Chatting again later takes both of you agreeing again.</p>
                  <div className="flex gap-2">
                    <button className="btn btn-danger" onClick={endChat}>End chat</button>
                    <button className="btn btn-secondary" onClick={() => setEnding(false)}>Keep</button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2 flex-wrap">
                  <button className="btn btn-primary" onClick={openChat}>Open chat</button>
                  <button className="btn btn-ghost text-sm" onClick={() => setEnding(true)}>End this chat</button>
                </div>
              )}
            </div>
          ) : decision === true ? (
            <p className="notice notice-ok" role="status">Recorded. If they also say yes, the chat appears under Chats. <button className="underline" onClick={() => decide(false)}>Change to no</button></p>
          ) : decision === false ? (
            <p className="muted text-sm" role="status">Recorded. <button className="underline" onClick={() => decide(true)}>Change to yes</button></p>
          ) : (
            <div className="flex gap-2">
              <button className="btn btn-primary" onClick={() => decide(true)}>Yes, keep talking</button>
              <button className="btn btn-secondary" onClick={() => decide(false)}>No thanks</button>
            </div>
          )}
        </section>
      )}

      <section className="card space-y-4">
        <h2 className="font-semibold text-xl">A quick reflection</h2>
        <p className="muted text-sm">Optional. Only you and the pilot team see this. It's how we learn whether this is worth doing.</p>
        <Scale label="Did you feel understood?" value={understood} onChange={setUnderstood} />
        <Scale label="Did you recognize something of your own experience in theirs?" value={shared} onChange={setShared} />
        <fieldset>
          <legend className="text-sm font-medium mb-2">Would you do this again with someone new?</legend>
          <div className="flex gap-2">
            <button type="button" className="chip" aria-pressed={repeat === true} onClick={() => setRepeat(true)}>Yes</button>
            <button type="button" className="chip" aria-pressed={repeat === false} onClick={() => setRepeat(false)}>No</button>
          </div>
        </fieldset>
        <label className="block text-sm font-medium" htmlFor="free">Anything else? (optional)</label>
        <textarea id="free" className="field" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn btn-primary" onClick={saveReflection}>{saved ? "Update" : "Save"}</button>
        {saved && <span className="muted text-sm ml-3" role="status">Saved.</span>}
      </section>

      {/* held messages of mine from this conversation stay appealable after it ended; outcomes show here */}
      <HeldMessages conversationId={conversationId} initial={initialHeld} />

      <Link href="/lobby" className="btn btn-secondary w-full">Back to Talk</Link>
    </div>
  );
}

function Scale({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <fieldset>
      <legend className="text-sm font-medium mb-2">{label}</legend>
      <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button type="button" key={n} role="radio" aria-checked={value === n} className="chip justify-center px-0" onClick={() => onChange(n)}>{n}</button>
        ))}
      </div>
      <div className="flex justify-between text-xs muted mt-1"><span>Not at all</span><span>Very much</span></div>
    </fieldset>
  );
}
