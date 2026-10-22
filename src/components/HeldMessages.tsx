"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { appealOutcome, canAcceptRevision, undeliverableText, type HeldMessage } from "@/lib/held-messages";

// The sender's own held messages and appeal outcomes for one conversation,
// reachable after a live conversation ended (reflection page) and in an
// ended or cleared chat. Participant-only: my_held_messages returns the
// caller's rows and nothing else. "Appeal sent" appears only after the server
// accepted the appeal; a failure is shown and the note is kept; the button is
// disabled while a request is in flight, so a double tap cannot file twice.
export function HeldMessages({ conversationId, initial = null, title = "Your held messages" }: { conversationId: string; initial?: HeldMessage[] | null; title?: string }) {
  const [rows, setRows] = useState<HeldMessage[]>(initial ?? []);
  const [loaded, setLoaded] = useState(initial !== null);
  const reload = useCallback(async () => {
    const { data, error } = await supabaseBrowser().rpc("my_held_messages", { p_conversation: conversationId });
    if (!error) setRows((data ?? []) as HeldMessage[]);
    setLoaded(true);
  }, [conversationId]);
  useEffect(() => { const t = setTimeout(() => { void reload(); }, 0); return () => clearTimeout(t); }, [reload]);   // deferred: no setState inside the effect itself
  if (!loaded || rows.length === 0) return null;
  return (
    <section className="card space-y-3" aria-label={title}>
      <h2 className="font-semibold text-lg">{title}</h2>
      <p className="muted text-sm">Messages of yours that were held back. The other person never saw them. You can still ask a reviewer to look at a decision, even though nothing can be sent here any more.</p>
      <ul className="space-y-3">
        {rows.map((m) => <HeldItem key={m.id} m={m} onChanged={reload} />)}
      </ul>
    </section>
  );
}

export function HeldItem({ m, onChanged }: { m: HeldMessage; onChanged: () => Promise<void> | void }) {
  const outcome = appealOutcome(m);
  const [note, setNote] = useState("");
  const [appealing, setAppealing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const act = async (action: "appeal" | "cancel" | "accept_revision") => {
    if (busy) return;
    setBusy(action); setError(null);
    try {
      const res = await fetch(`/api/messages/${m.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action === "appeal" ? { action, note } : { action }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error ?? "Something went wrong. Your note is still here; try again."); return; }
      if (action === "appeal") { setSent(true); setAppealing(false); }
      await onChanged();
    } catch { setError("Couldn't reach the server. Your note is still here; try again."); }
    finally { setBusy(null); }
  };
  const held = m.status === "revise" || m.status === "blocked";
  return (
    <li className="rounded-xl px-3 py-2 text-sm space-y-2" style={{ background: "var(--mine)" }} data-testid="held-message">
      <div className="whitespace-pre-wrap break-words">{m.body}</div>
      {held && <p className={m.status === "blocked" ? "notice notice-bad" : "notice notice-warn"}>Not delivered. {m.user_explanation}</p>}
      {m.undeliverable_reason && held && <p className="text-xs">{undeliverableText(m.undeliverable_reason)}</p>}
      {error && <p className="notice notice-bad text-xs" role="alert">{error}</p>}
      {outcome.state === "none" && outcome.canAppeal && !sent && (
        appealing ? (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void act("appeal"); }}>
            <label className="block text-xs" htmlFor={`appeal-${m.id}`}>Tell the reviewer why this decision should be reconsidered (optional)</label>
            <textarea id={`appeal-${m.id}`} className="field text-sm" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex gap-2">
              <button className="btn btn-primary text-xs px-3 py-1.5 min-h-0" disabled={!!busy}>{busy === "appeal" ? "Sending…" : "Send appeal"}</button>
              <button type="button" className="btn btn-ghost text-xs px-3 py-1.5 min-h-0" disabled={!!busy} onClick={() => setAppealing(false)}>Back</button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            {canAcceptRevision(m) && <button className="btn btn-primary text-xs px-3 py-1.5 min-h-0" disabled={!!busy} onClick={() => act("accept_revision")}>Send this version</button>}
            <button className="btn btn-ghost text-xs px-3 py-1.5 min-h-0" disabled={!!busy} onClick={() => setAppealing(true)}>Appeal</button>
            <button className="btn btn-secondary text-xs px-3 py-1.5 min-h-0" disabled={!!busy} onClick={() => act("cancel")}>Discard</button>
          </div>
        )
      )}
      {(sent || outcome.state === "open") && <p className="text-xs" role="status">Appeal sent. A reviewer will look at it; the message stays undelivered unless they overturn the decision.{outcome.state === "open" && outcome.note ? ` Your note: “${outcome.note}”` : note && sent ? ` Your note: “${note}”` : ""}</p>}
      {outcome.state === "upheld" && <p className="text-xs" role="status">Appeal reviewed: the decision stands.{outcome.resolutionNote ? ` Reviewer: ${outcome.resolutionNote}` : ""}</p>}
      {outcome.state === "overturned" && (
        <p className="text-xs" role="status">{outcome.delivered ? "Appeal accepted: the message was delivered." : (outcome.explanation ?? "Appeal accepted, but the message could not be delivered.")}{outcome.resolutionNote ? ` Reviewer: ${outcome.resolutionNote}` : ""}</p>
      )}
    </li>
  );
}
