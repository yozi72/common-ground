"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Conn = { connection_id: string; peer_alias: string; my_alias: string; since: string; status: string; pending_invitation_id: string | null };

export function Connections({ initial }: { initial: Conn[] }) {
  const router = useRouter();
  // Rendered from props so router.refresh() always shows fresh data; only the
  // just-sent invitation ids are kept locally until the next refresh.
  const [sentInvites, setSentInvites] = useState<Record<string, string>>({});
  const list = initial.map((c) => (sentInvites[c.connection_id] ? { ...c, pending_invitation_id: sentInvites[c.connection_id] } : c));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function reconnect(id: string) {
    setBusy(id); setError(null);
    const res = await fetch(`/api/connections/${id}`, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setError(json.error ?? "Something went wrong"); return; }
    setSentInvites((m) => ({ ...m, [id]: json.invitation_id }));
    router.refresh();
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
              <button className="btn btn-primary" disabled={busy === c.connection_id} onClick={() => reconnect(c.connection_id)}>Invite to talk again</button>
            ))}
          </li>
        ))}
      </ul>
      <button className="btn btn-ghost" onClick={() => router.refresh()}>Refresh</button>
    </div>
  );
}
