"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Decision = { decision: string; categories: string[]; detector_hits: string[]; provider: string; confidence: number | null; created_at: string };
type Review = { id: string; conversation_id: string; kind: string; body: string; status: string; attempts: number; last_error: string | null; user_explanation: string | null; created_at: string; moderation_decisions: Decision[] };
type Report = { id: string; conversation_id: string | null; reason: string; details: string | null; status: string; message_ids: string[]; created_at: string };
type Appeal = { id: string; note: string | null; status: string; created_at: string; pending_messages: { id: string; body: string; status: string; user_explanation: string | null } | null };
type Cfg = { key: string; value: unknown };
type Ctx = { id: string; conversation_id: string; sender_participant_id: string; body: string; created_at: string };

export function AdminConsole({ review, reports, appeals, config, context, waiting }: { review: Review[]; reports: Report[]; appeals: Appeal[]; config: Cfg[]; context: Ctx[]; waiting: number }) {
  const router = useRouter();
  const [tab, setTab] = useState<"messages" | "reports" | "appeals" | "config">("messages");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(body: unknown) {
    setBusy(true); setError(null);
    const res = await fetch("/api/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(json.error ?? "Failed"); return; }
    router.refresh();
  }

  const tabs = [["messages", "Held messages", review.filter((r) => r.status === "review").length], ["reports", "Reports", reports.length], ["appeals", "Appeals", appeals.length], ["config", "Policy", 0]] as const;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl font-semibold">Review</h1>
        <p className="muted text-sm">{waiting} waiting in the queue. Decisions here are enforced server-side and logged like automated ones.</p>
      </div>
      <nav aria-label="Review sections" className="flex gap-1 flex-wrap p-1 rounded-full" style={{ background: "var(--bg-2)" }}>
        {tabs.map(([k, label, n]) => (
          <button key={k} className="tab" aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>
            {label}{n > 0 && <span className="count">{n}</span>}
          </button>
        ))}
      </nav>
      {error && <div className="notice notice-bad" role="alert">{error}</div>}

      {tab === "messages" && (
        <ul className="space-y-3">
          {review.length === 0 && <li className="card-flat muted text-sm text-center">Nothing held. Messages the automated review can't decide on will wait here.</li>}
          {review.map((r) => (
            <li key={r.id} className="card-flat space-y-2 text-sm">
              <div className="flex justify-between gap-2 flex-wrap"><span className="font-mono text-xs muted">{r.status} · {r.kind} · attempts {r.attempts} · {new Date(r.created_at).toLocaleString()}</span></div>
              <p className="whitespace-pre-wrap break-words">{r.body}</p>
              {r.last_error && <p className="notice notice-warn">Last error: {r.last_error}</p>}
              {r.moderation_decisions?.map((d, i) => (
                <p key={i} className="muted text-xs">{d.provider}: {d.decision} · {d.categories.join(", ") || "no categories"} · detectors: {d.detector_hits.join(", ") || "none"} · confidence {d.confidence ?? "—"}</p>
              ))}
              {r.status === "review" && (
                <div className="flex gap-2">
                  <button className="btn btn-primary text-xs" disabled={busy} onClick={() => act({ action: "resolve_pending", pending_id: r.id, decision: "allow" })}>Deliver</button>
                  <button className="btn btn-danger text-xs" disabled={busy} onClick={() => act({ action: "resolve_pending", pending_id: r.id, decision: "block", note: prompt("Explanation shown to the sender:") ?? undefined })}>Block</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {tab === "reports" && (
        <ul className="space-y-3">
          {reports.length === 0 && <li className="card-flat muted text-sm text-center">No open reports.</li>}
          {reports.map((r) => (
            <li key={r.id} className="card-flat space-y-2 text-sm">
              <p><strong>{r.reason}</strong> · {r.status} · {new Date(r.created_at).toLocaleString()}</p>
              {r.details && <p className="whitespace-pre-wrap">{r.details}</p>}
              <details>
                <summary className="cursor-pointer muted">Recent messages in that conversation</summary>
                <ul className="mt-2 space-y-1">
                  {context.filter((c) => c.conversation_id === r.conversation_id).reverse().map((c) => (
                    <li key={c.id} className="rounded p-2" style={{ background: r.message_ids.includes(c.id) ? "var(--warn-bg)" : "var(--theirs)" }}>
                      <span className="font-mono text-xs muted">{c.sender_participant_id.slice(0, 6)}</span> {c.body}
                    </li>
                  ))}
                </ul>
              </details>
              <div className="flex gap-2 flex-wrap">
                {r.status === "open" && <button className="btn btn-secondary text-xs" disabled={busy} onClick={() => act({ action: "resolve_report", report_id: r.id, status: "reviewing" })}>Mark reviewing</button>}
                <button className="btn btn-primary text-xs" disabled={busy} onClick={() => act({ action: "resolve_report", report_id: r.id, status: "resolved", note: prompt("Resolution note:") ?? undefined })}>Resolve</button>
                <button className="btn btn-ghost text-xs" disabled={busy} onClick={() => act({ action: "resolve_report", report_id: r.id, status: "dismissed" })}>Dismiss</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === "appeals" && (
        <ul className="space-y-3">
          {appeals.length === 0 && <li className="card-flat muted text-sm text-center">No open appeals.</li>}
          {appeals.map((a) => (
            <li key={a.id} className="card-flat space-y-2 text-sm">
              <p className="whitespace-pre-wrap break-words">{a.pending_messages?.body}</p>
              <p className="muted text-xs">Original decision: {a.pending_messages?.status} · {a.pending_messages?.user_explanation}</p>
              {a.note && <p>Sender says: {a.note}</p>}
              <div className="flex gap-2">
                <button className="btn btn-primary text-xs" disabled={busy} onClick={() => act({ action: "resolve_appeal", appeal_id: a.id, status: "overturned" })}>Overturn and deliver</button>
                <button className="btn btn-secondary text-xs" disabled={busy} onClick={() => act({ action: "resolve_appeal", appeal_id: a.id, status: "upheld" })}>Uphold</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === "config" && (
        <ul className="space-y-2">
          {config.map((c) => (
            <li key={c.key} className="card-flat flex items-center justify-between gap-3 text-sm flex-wrap">
              <code>{c.key}</code>
              <div className="flex gap-2 items-center">
                <code className="muted">{JSON.stringify(c.value)}</code>
                <button className="btn btn-secondary text-xs" disabled={busy} onClick={() => {
                  const v = prompt(`New JSON value for ${c.key}:`, JSON.stringify(c.value));
                  if (v == null) return;
                  try { act({ action: "set_config", key: c.key, value: JSON.parse(v) }); } catch { setError("Not valid JSON"); }
                }}>Edit</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
