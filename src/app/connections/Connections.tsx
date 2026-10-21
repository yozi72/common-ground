"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { UNREAD_CHANGED } from "@/components/useUnread";

type Thread = { connection_id: string; conversation_id: string | null; peer_alias: string; my_alias: string; since: string; status: string; unread: number; last_message_at: string | null; muted: boolean };

// The list keeps itself current (new messages, reads elsewhere, removals): a
// realtime notification, the chat's "read" event, focus/visibility and a 30 s
// fallback all re-fetch the overview. The Refresh button stays as a manual fallback.
export function Connections({ initial }: { initial: Thread[] }) {
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const reload = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    const { data, error } = await supabaseBrowser().rpc("friend_threads_overview");
    if (manual) setRefreshing(false);
    if (error) { if (manual) setError("Couldn't refresh. Try again."); return; }
    setThreads((data ?? []) as Thread[]);
  }, []);

  useEffect(() => {
    const sb = supabaseBrowser();
    const onEvent = () => reload();
    const onVisible = () => { if (document.visibilityState === "visible") reload(); };
    const ch = sb.channel(`friends-list-${crypto.randomUUID()}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, onEvent).subscribe();
    const t = setInterval(onEvent, 30_000);
    window.addEventListener(UNREAD_CHANGED, onEvent);
    window.addEventListener("focus", onEvent);
    document.addEventListener("visibilitychange", onVisible);
    return () => { sb.removeChannel(ch); clearInterval(t); window.removeEventListener(UNREAD_CHANGED, onEvent); window.removeEventListener("focus", onEvent); document.removeEventListener("visibilitychange", onVisible); };
  }, [reload]);

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
    await reload();
    window.dispatchEvent(new Event(UNREAD_CHANGED));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Friends</h1>
        <p className="muted text-sm mt-1">People you&apos;ve both agreed to keep talking with. Each friendship has one chat you can use any time, even when the other person is offline; they&apos;ll see your message when they come back. Still aliases only; contact sharing isn&apos;t part of this pilot. Messages are checked before delivery and deleted 30 days after they were sent.</p>
      </div>
      {error && <div className="notice notice-bad" role="alert">{error}</div>}
      {threads.length === 0 && <p className="card muted text-sm">No friends yet. After a conversation, you&apos;ll be asked privately whether you&apos;d talk again; if you both say yes, they show up here.</p>}
      <ul className="space-y-3" aria-live="polite">
        {threads.map((c) => (
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
                <button className="btn btn-primary" disabled={busy === c.connection_id} onClick={() => open(c.connection_id)}>{c.unread > 0 ? "Read & reply" : c.conversation_id ? "Open chat" : "Message"}</button>
              ) : c.conversation_id ? (
                <a className="btn btn-secondary" href={`/c/${c.conversation_id}`}>View history</a>
              ) : null}
            </div>
            {c.status === "active" && (confirmRemove === c.connection_id ? (
              <div className="notice notice-warn space-y-2 text-sm" role="alertdialog">
                <p>Remove {c.peer_alias} as a friend? Messaging stops for both of you. Existing messages stay readable until they expire. If you ever want to reconnect, you&apos;ll both need to agree again.</p>
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
      <button className="btn btn-ghost" disabled={refreshing} onClick={() => reload(true)}>{refreshing ? "Refreshing…" : "Refresh"}</button>
    </div>
  );
}
