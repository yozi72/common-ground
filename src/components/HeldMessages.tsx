"use client";
import { useCallback, useEffect, useReducer, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { appealFormInitial, appealFormReducer, appealOutcome, canAcceptRevision, heldNeedsRefresh, undeliverableText, type HeldMessage } from "@/lib/held-messages";

// The sender's own held messages (revise / blocked / cancelled after an appeal)
// with their persisted appeal state, from my_held_messages (participant-only).
// Used on the reflection page of an ended live conversation, in an ended or
// cleared chat, and inside an open chat (via HeldItem). While an appeal is open
// the list re-fetches on a bounded interval so a reviewer's decision shows
// without a reload; otherwise it only re-fetches when the parent asks.
export function HeldMessages({ conversationId, initial = null, open = false, title = "Your held messages", refreshKey = 0 }: { conversationId: string; initial?: HeldMessage[] | null; open?: boolean; title?: string; refreshKey?: number }) {
  const [rows, setRows] = useState<HeldMessage[]>(initial ?? []);
  const [loaded, setLoaded] = useState(initial !== null);
  const reload = useCallback(async () => {
    const { data, error } = await supabaseBrowser().rpc("my_held_messages", { p_conversation: conversationId });
    if (!error) setRows((data ?? []) as HeldMessage[]);
    setLoaded(true);
  }, [conversationId]);
  useEffect(() => { const t = setTimeout(() => { void reload(); }, 0); return () => clearTimeout(t); }, [reload, refreshKey]);   // deferred: no setState inside the effect itself
  const needsRefresh = heldNeedsRefresh(rows);
  useEffect(() => {
    if (!needsRefresh) return;
    const t = setInterval(() => { void reload(); }, 15_000);   // bounded: only while an appeal is open
    return () => clearInterval(t);
  }, [needsRefresh, reload]);
  if (!loaded || rows.length === 0) return null;
  return (
    <section className="card space-y-3" aria-label={title}>
      <h2 className="font-semibold text-lg">{title}</h2>
      <p className="muted text-sm">{open
        ? "Messages of yours that were held back. The other person never saw them. You can accept a rewording where one is offered, or ask a reviewer to look at the decision."
        : "Messages of yours that were held back. The other person never saw them. You can still ask a reviewer to look at a decision, even though nothing can be sent here any more."}</p>
      <ul className="space-y-3">
        {rows.map((m) => <HeldItem key={m.id} m={m} open={open} onChanged={reload} />)}
      </ul>
    </section>
  );
}

// One held message with the shared appeal controls. `open`: the chat is still
// usable, so a deliverable revision can be accepted and the copy says so.
export function HeldItem({ m, open = false, onChanged }: { m: HeldMessage; open?: boolean; onChanged: () => Promise<void> | void }) {
  const outcome = appealOutcome(m);
  const [form, dispatch] = useReducer(appealFormReducer, appealFormInitial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const post = (body: unknown) => fetch(`/api/messages/${m.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const submitAppeal = async () => {
    if (form.phase === "sending" || form.phase === "sent") return;   // no duplicate submissions
    dispatch({ type: "submit" });
    try {
      const res = await post({ action: "appeal", note: form.note });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { dispatch({ type: "failed", error: json.error ?? "Something went wrong. Your note is still here; try again." }); return; }
      dispatch({ type: "accepted" });
      await onChanged();
    } catch { dispatch({ type: "failed", error: "Couldn't reach the server. Your note is still here; try again." }); }
  };
  const act = async (action: "cancel" | "accept_revision") => {
    if (busy) return;
    setBusy(action); setError(null);
    try {
      const res = await post({ action });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error ?? "Something went wrong"); return; }
      await onChanged();
    } catch { setError("Couldn't reach the server. Try again."); }
    finally { setBusy(null); }
  };
  const held = m.status === "revise" || m.status === "blocked";
  const sending = form.phase === "sending";
  const appealable = outcome.state === "none" && outcome.canAppeal && form.phase !== "sent";
  return (
    <li className="rounded-xl px-3 py-2 text-sm space-y-2" style={{ background: "var(--mine)" }} data-testid="held-message">
      <div className="whitespace-pre-wrap break-words">{m.body}</div>
      {held && <p className={m.status === "blocked" ? "notice notice-bad" : "notice notice-warn"}>Not delivered. {m.user_explanation}</p>}
      {m.undeliverable_reason && held && <p className="text-xs">{undeliverableText(m.undeliverable_reason)}{open ? "" : " You can still appeal the decision for the record."}</p>}
      {held && open && canAcceptRevision(m) && (
        <div className="rounded-lg p-2 text-sm" style={{ background: "var(--card)" }}>
          <p className="text-xs muted mb-1">Suggested rewording (sent only if you accept):</p>
          <p>{m.suggested_revision}</p>
        </div>
      )}
      {error && <p className="notice notice-bad text-xs" role="alert">{error}</p>}
      {appealable && (
        form.phase === "editing" || form.phase === "sending" || form.phase === "error" ? (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void submitAppeal(); }}>
            <label className="block text-xs" htmlFor={`appeal-${m.id}`}>Tell the reviewer why this decision should be reconsidered (optional)</label>
            <textarea id={`appeal-${m.id}`} className="field text-sm" rows={2} maxLength={1000} value={form.note} disabled={sending} onChange={(e) => dispatch({ type: "note", note: e.target.value })} />
            {form.error && <p className="notice notice-bad text-xs" role="alert">{form.error}</p>}
            <div className="flex gap-2">
              <button className="btn btn-primary text-xs px-3 py-1.5 min-h-0" disabled={sending}>{sending ? "Sending…" : form.phase === "error" ? "Try again" : "Send appeal"}</button>
              <button type="button" className="btn btn-ghost text-xs px-3 py-1.5 min-h-0" disabled={sending} onClick={() => dispatch({ type: "close" })}>Back</button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            {open && canAcceptRevision(m) && <button className="btn btn-primary text-xs px-3 py-1.5 min-h-0" disabled={!!busy} onClick={() => act("accept_revision")}>Send this version</button>}
            <button className="btn btn-ghost text-xs px-3 py-1.5 min-h-0" disabled={!!busy} onClick={() => dispatch({ type: "open" })}>Appeal</button>
            <button className="btn btn-secondary text-xs px-3 py-1.5 min-h-0" disabled={!!busy} onClick={() => act("cancel")}>{m.status === "blocked" ? "Dismiss" : "Discard"}</button>
          </div>
        )
      )}
      {(form.phase === "sent" || outcome.state === "open") && <p className="text-xs" role="status">Appeal sent. A reviewer will look at it; the message stays undelivered unless they overturn the decision.{outcome.state === "open" && outcome.note ? ` Your note: “${outcome.note}”` : form.phase === "sent" && form.note ? ` Your note: “${form.note}”` : ""}</p>}
      {outcome.state === "upheld" && <p className="text-xs" role="status">Appeal reviewed: the decision stands.{outcome.resolutionNote ? ` Reviewer: ${outcome.resolutionNote}` : ""}</p>}
      {outcome.state === "overturned" && (
        <p className="text-xs" role="status">{outcome.delivered ? "Appeal accepted: the message was delivered." : (outcome.explanation ?? "Appeal accepted, but the message could not be delivered.")}{outcome.resolutionNote ? ` Reviewer: ${outcome.resolutionNote}` : ""}</p>
      )}
    </li>
  );
}
