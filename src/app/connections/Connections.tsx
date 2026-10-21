"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Thread = { connection_id: string; conversation_id: string | null; peer_alias: string; my_alias: string; since: string; status: string; unread: number; last_message_at: string | null; muted: boolean };

export function Connections({ initial }: { initial: Thread[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  async function open(id: string) {
    setBusy(id); setError(null);
    const res = await fetch(`/api/connections/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "open" }) });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setError(json.error ?? "Something went wrong"); return; }
    router.push(`/c/${json.conversation_id}`);
  }
  async function remove(id: string) {
    setBusy(id); setError(null);
    const res = await fetch(`/api/connections/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove" }) });
    setBusy(null); setConfirmRemove(null);
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? "Something went wrong"); return; }
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Friends</h1>
        <p className="muted text-sm mt-1">People you&apos;ve both agreed to keep talking with. Each friendship has one chat you can use any time, even when the other person is offline; they&apos;ll see your message when they come back. Still aliases only; contact sharing isn&apos;t part of this pilot. Messages are checked before delivery and deleted 30 days after they were sent.</p>
      </div>
      {error && <div className="notice notice-bad" role="alert">{error}</div>}
      {initial.length === 0 && <p className="card muted text-sm">No friends yet. After a conversation, you&apos;ll be asked privately whether you&apos;d talk again; if you both say yes, they show up here.</p>}
      <ul className="space-y-3">
        {initial.map((c) => (
          <li key={c.connection_id} className="card space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <p className="font-semibold text-lg flex items-center gap-2">
                  {c.peer_alias}
                  {c.unread > 0 && <span className="count" aria-label={`${c.unread} unread`}>{c.unread}</span>}
                  {c.muted && <span className="badge" style={{ background: "var(--bg-2)", color: "var(--muted)" }}>muted</span>}
                </p>
                <p className="muted text-xs">You&apos;re {c.my_alias} to them · friends since {new Date(c.since).toLocaleDateString()}{c.status === "ended" ? " · ended" : c.last_message_at ? ` · last message ${new Date(c.last_message_at).toLocaleDateString()}` : ""}</p>
              </div>
              {c.status === "active" ? (
                <button className="btn btn-primary" disabled={busy === c.connection_id || pending} onClick={() => open(c.connection_id)}>{c.unread > 0 ? "Read & reply" : c.conversation_id ? "Open chat" : "Message"}</button>
              ) : c.conversation_id ? (
                <a className="btn btn-secondary" href={`/c/${c.conversation_id}`}>View history</a>
              ) : null}
            </div>
            {c.status === "active" && (confirmRemove === c.connection_id ? (
              <div className="notice notice-warn space-y-2 text-sm" role="alertdialog">
                <p>Remove {c.peer_alias} as a friend? Neither of you can send new messages; existing ones stay readable until they expire. This can&apos;t be undone.</p>
                <div className="flex gap-2">
                  <button className="btn btn-danger" disabled={busy === c.connection_id} onClick={() => remove(c.connection_id)}>Remove friend</button>
                  <button className="btn btn-secondary" onClick={() => setConfirmRemove(null)}>Keep</button>
                </div>
              </div>
            ) : (
              <button className="btn btn-ghost text-xs px-2 py-1 min-h-0" onClick={() => setConfirmRemove(c.connection_id)}>Remove friend</button>
            ))}
          </li>
        ))}
      </ul>
      <button className="btn btn-ghost" disabled={pending} onClick={() => startTransition(() => router.refresh())}>{pending ? "Refreshing…" : "Refresh"}</button>
    </div>
  );
}
