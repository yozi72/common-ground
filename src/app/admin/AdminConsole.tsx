"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Decision = { decision: string; categories: string[]; detector_hits: string[]; provider: string; confidence: number | null; created_at: string };
type Review = { id: string; conversation_id: string; kind: string; body: string; status: string; attempts: number; last_error: string | null; user_explanation: string | null; created_at: string; moderation_decisions: Decision[] };
type Report = { id: string; conversation_id: string | null; reason: string; details: string | null; status: string; message_ids: string[]; created_at: string };
type Appeal = { id: string; note: string | null; status: string; created_at: string; pending_messages: { id: string; body: string; status: string; user_explanation: string | null } | null };
type Cfg = { key: string; value: unknown };
type EvidenceMsg = { id: string; alias: string; kind: string; body: string; at: string };
type Evidence = { report_id: string; cited: EvidenceMsg[]; context: EvidenceMsg[] };

type Metrics = Record<string, number | string | null> | null;

export function AdminConsole({ review, reports, appeals, config, evidence, waiting, metrics, metricsError }: { review: Review[]; reports: Report[]; appeals: Appeal[]; config: Cfg[]; evidence: Evidence[]; waiting: number; metrics: Metrics; metricsError: string | null }) {
  const router = useRouter();
  const [tab, setTab] = useState<"messages" | "reports" | "appeals" | "metrics" | "config">("messages");
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

  const tabs = [["messages", "Held messages", review.filter((r) => r.status === "review").length], ["reports", "Reports", reports.length], ["appeals", "Appeals", appeals.length], ["metrics", "Metrics", 0], ["config", "Policy", 0]] as const;

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
              {(() => {
                const ev = evidence.find((e) => e.report_id === r.id);
                if (!ev) return <p className="muted text-xs">No evidence snapshot: this report was filed before snapshots were captured, so what the reporter saw is not available here.</p>;
                const citedIds = new Set(ev.cited.map((c) => c.id));
                const context = ev.context.filter((c) => !citedIds.has(c.id));
                return (
                  <div className="space-y-2">
                    <div>
                      <p className="text-xs font-semibold">Cited by the reporter ({ev.cited.length})</p>
                      {ev.cited.length === 0 && <p className="muted text-xs">The reporter cited no specific messages.</p>}
                      <ul className="mt-1 space-y-1">
                        {ev.cited.map((c) => (
                          <li key={c.id} className="rounded p-2" style={{ background: "var(--warn-bg)" }}>
                            <span className="text-xs muted">{c.alias}{c.kind === "answer" ? " (answer)" : ""} · {new Date(c.at).toLocaleString()}</span> {c.body}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <details>
                      <summary className="cursor-pointer muted text-xs">Recent context the reporter could see at the time ({context.length}{context.length ? "" : ", none"})</summary>
                      <ul className="mt-2 space-y-1">
                        {context.map((c) => (
                          <li key={c.id} className="rounded p-2" style={{ background: "var(--theirs)" }}>
                            <span className="text-xs muted">{c.alias}{c.kind === "answer" ? " (answer)" : ""} · {new Date(c.at).toLocaleTimeString()}</span> {c.body}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                );
              })()}
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

      {tab === "metrics" && (
        <section className="space-y-3">
          <p className="muted text-sm">Last 14 days. Operational only: no conversation text, no questionnaire answers. Waits are reported for people who were matched; the unmatched rate shows how many joined and left without a match.</p>
          {metricsError ? <p className="notice notice-bad text-sm" role="alert">Metrics couldn&apos;t be loaded: {metricsError}</p> : !metrics ? <p className="card-flat muted text-sm">No data yet.</p> : (
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
              {[
                ["Queue joins", metrics.queue_joins], ["Sessions with joins", metrics.sessions_with_joins],
                ["Invitations", metrics.invitations], ["Time to invitation p50 (s)", metrics.time_to_invitation_p50_s], ["Time to invitation p90 (s)", metrics.time_to_invitation_p90_s],
                ["Conversations opened", metrics.conversations_opened], ["Time until both accept p50 (s)", metrics.time_to_both_accept_p50_s],
                ["Started within 2 min", metrics.started_within_2min], ["Started within 2 min %", metrics.started_within_2min_pct],
                ["Left unmatched", metrics.unmatched_leaves], ["Unmatched rate %", metrics.unmatched_rate_pct],
                ["Invitations missed", metrics.invitations_missed], ["Invitations declined", metrics.invitations_declined],
                ["Broadened match", metrics.broaden_selected], ["Chose 'anyone'", metrics.broaden_any],
                ["Reminder opt-ins", metrics.reminder_optins], ["Reminders sent", metrics.reminders_sent], ["Reminders failed", metrics.reminders_failed], ["Reminders skipped", metrics.reminders_skipped],
              ].map(([k, v]) => (
                <div key={String(k)} className="card-flat"><dt className="muted text-xs">{k}</dt><dd className="text-lg font-semibold">{v == null ? "—" : typeof v === "number" ? Math.round(v * 10) / 10 : String(v)}</dd></div>
              ))}
            </dl>
          )}
        </section>
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
