"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Conn = { connection_id: string; peer_alias: string; my_alias: string; since: string; status: string; pending_invitation_id: string | null };

export function Connections({ initial }: { initial: Conn[] }) {
  const router = useRouter();
  // Rendered straight from server props: after an invite we refresh the server
  // data (which reports a pending invitation only while it is still valid),
  // so expired or declined invitations never linger in the UI.
  const list = initial;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function reconnect(id: string) {
    setBusy(id); setError(null);
    const res = await fetch(`/api/connections/${id}`, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setError(json.error ?? "Something went wrong"); return; }
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Friends</h1>
        <p className="muted text-sm mt-1">People you've both agreed to talk with again. Still aliases only; contact sharing isn't part of this pilot.</p>
      </div>
      {error && <div className="notice notice-bad" role="alert">{error}</div>}
      {list.length === 0 && <p className="card muted text-sm">No friends yet. After a conversation, you'll be asked privately whether you'd talk again; if you both say yes, they show up here.</p>}
      <ul className="space-y-3">
        {list.map((c) => (
          <li key={c.connection_id} className="card flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="font-semibold text-lg">{c.peer_alias}</p>
              <p className="muted text-xs">You're {c.my_alias} to them · since {new Date(c.since).toLocaleDateString()}{c.status === "ended" ? " · ended" : ""}</p>
            </div>
            {c.status === "active" && (c.pending_invitation_id ? (
              <span className="muted text-sm">Invitation sent. <Link className="underline" href="/lobby">Check Talk</Link></span>
            ) : (
              <button className="btn btn-primary" disabled={busy === c.connection_id || pending} onClick={() => reconnect(c.connection_id)}>{busy === c.connection_id || pending ? "Sending…" : "Invite to talk again"}</button>
            ))}
          </li>
        ))}
      </ul>
      <button className="btn btn-ghost" disabled={pending} onClick={() => startTransition(() => router.refresh())}>{pending ? "Refreshing…" : "Refresh"}</button>
    </div>
  );
}
