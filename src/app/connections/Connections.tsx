"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { UNREAD_CHANGED } from "@/components/useUnread";

type Thread = { connection_id: string; conversation_id: string | null; peer_alias: string; my_alias: string; since: string; status: string; unread: number; last_message_at: string | null; muted: boolean; tier: "chat" | "friend"; request_from_me: boolean; request_for_me: boolean; request_available: boolean; friends_since: string | null };
// both_yes: both decided "keep talking" in THIS conversation. connected: an active
// chat with this person already exists (from this or an earlier conversation).
export type Recent = { conversation_id: string; peer_alias: string; ended_at: string; end_reason: string | null; questions_asked: number; my_decision: boolean | null; both_yes: boolean; connected: boolean; reflection_done: boolean; connection_id: string | null; thread_id: string | null };

// The list keeps itself current (new messages, reads elsewhere, requests,
// removals): a realtime notification, the chat's "read" event, focus/visibility
// and a 30 s fallback all re-fetch. The Refresh button stays as a manual fallback.
export function Connections({ initialThreads, initialRecent }: { initialThreads: Thread[]; initialRecent: Recent[] }) {
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[]>(initialThreads);
  const [recent, setRecent] = useState<Recent[]>(initialRecent);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const reload = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    const sb = supabaseBrowser();
    const [t, r] = await Promise.all([sb.rpc("friend_threads_overview"), sb.rpc("my_recent_conversations")]);
    if (manual) setRefreshing(false);
    if (t.error || r.error) { if (manual) setError("Couldn't refresh. Try again."); return; }
    setThreads((t.data ?? []) as Thread[]);
    setRecent((r.data ?? []) as Recent[]);
  }, []);

  useEffect(() => {
    const sb = supabaseBrowser();
    const onEvent = () => reload();
    const onVisible = () => { if (document.visibilityState === "visible") reload(); };
    const ch = sb.channel(`chats-list-${crypto.randomUUID()}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, onEvent).subscribe();
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

  const active = threads.filter((c) => c.status === "active");
  const ended = threads.filter((c) => c.status !== "active" && c.conversation_id);
  // ended conversations that already turned into a chat are shown as chats, not twice;
  // a rematch with someone you already chat with points at that chat instead of asking again
  const undecided = recent.filter((r) => !r.both_yes && !r.connected);
  const rematches = recent.filter((r) => !r.both_yes && r.connected);
  const day = (iso: string) => new Date(iso).toLocaleDateString();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Chats</h1>
        <p className="muted text-sm mt-1">Conversations you both chose to keep. Use a chat any time, even when the other person is offline. Messages are still checked before delivery, and contact details stay held back until you both choose to become friends. History stays until either of you clears it.</p>
      </div>
      {error && <div className="notice notice-bad" role="alert">{error}</div>}

      {active.length === 0 && undecided.length === 0 && <p className="card muted text-sm">Nothing here yet. After a conversation, you&apos;ll be asked privately whether you&apos;d like to keep talking; if you both say yes, the chat shows up here.</p>}

      {active.length > 0 && (
        <ul className="space-y-3" aria-live="polite" aria-label="Your chats">
          {active.map((c) => (
            <li key={c.connection_id} className="card space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="font-semibold text-lg flex items-center gap-2">
                    {c.peer_alias}
                    {c.tier === "friend" && <span className="badge" style={{ background: "var(--sage-2)", color: "var(--sage)" }}>friends</span>}
                    {c.unread > 0 && <span className="count" aria-label={`${c.unread} unread`}>{c.unread}</span>}
                    {c.muted && <span className="badge" style={{ background: "var(--bg-2)", color: "var(--muted)" }}>muted</span>}
                  </p>
                  <p className="muted text-xs">You&apos;re {c.my_alias} to them · since {day(c.since)}{c.last_message_at ? ` · last message ${day(c.last_message_at)}` : ""}</p>
                  {c.request_for_me && <p className="text-sm mt-1" style={{ color: "var(--accent)" }}>{c.peer_alias} asked to become friends. Open the chat to answer.</p>}
                  {c.request_from_me && <p className="muted text-sm mt-1">You asked to become friends.</p>}
                </div>
                <button className="btn btn-primary" disabled={busy === c.connection_id} onClick={() => open(c.connection_id)}>{c.unread > 0 ? "Read & reply" : c.conversation_id ? "Open chat" : "Message"}</button>
              </div>
              {confirmRemove === c.connection_id ? (
                <div className="notice notice-warn space-y-2 text-sm" role="alertdialog">
                  <p>End this chat with {c.peer_alias}? Messaging stops for both of you. What&apos;s here stays readable for 30 days, then it&apos;s deleted. If you ever want to chat again, you&apos;ll both need to agree again, and it starts over without contact sharing.</p>
                  <div className="flex gap-2">
                    <button className="btn btn-danger" disabled={busy === c.connection_id} onClick={() => remove(c.connection_id)}>End chat</button>
                    <button className="btn btn-secondary" onClick={() => setConfirmRemove(null)}>Keep</button>
                  </div>
                </div>
              ) : (
                <button className="btn btn-ghost text-xs px-2 py-1 min-h-0" onClick={() => setConfirmRemove(c.connection_id)}>End chat</button>
              )}
            </li>
          ))}
        </ul>
      )}

      {undecided.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold text-lg">Recent conversations</h2>
          <p className="muted text-sm">Listed for 30 days so you can still reflect and decide whether to keep talking.</p>
          <ul className="space-y-3" aria-label="Recent conversations">
            {undecided.map((r) => (
              <li key={r.conversation_id} className="card flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="font-semibold">{r.peer_alias}</p>
                  <p className="muted text-xs">{day(r.ended_at)}{r.questions_asked > 0 ? ` · ${r.questions_asked} question${r.questions_asked === 1 ? "" : "s"}` : ""}</p>
                  <p className="text-sm mt-1">
                    {r.my_decision === null ? "You haven't decided whether to keep talking." : r.my_decision ? "You said yes, waiting for them." : "You said no thanks."}
                    {!r.reflection_done && r.my_decision !== null ? " Reflection not done yet." : ""}
                  </p>
                </div>
                <a className={r.my_decision === null ? "btn btn-primary" : "btn btn-secondary"} href={`/c/${r.conversation_id}/reflect`}>{r.my_decision === null ? "Decide & reflect" : "Open"}</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {rematches.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold text-lg">Met again</h2>
          <ul className="space-y-3" aria-label="Conversations with people you already chat with">
            {rematches.map((r) => (
              <li key={r.conversation_id} className="card flex items-center justify-between gap-3 flex-wrap" data-testid="rematch">
                <div>
                  <p className="font-semibold">{r.peer_alias}</p>
                  <p className="muted text-xs">{day(r.ended_at)}{r.questions_asked > 0 ? ` · ${r.questions_asked} question${r.questions_asked === 1 ? "" : "s"}` : ""}</p>
                  <p className="text-sm mt-1">You already chat with {r.peer_alias}; nothing to decide here.{!r.reflection_done ? " You can still reflect on this conversation." : ""}</p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {r.connection_id && <button className="btn btn-primary" disabled={busy === r.connection_id} onClick={() => open(r.connection_id!)}>Open chat</button>}
                  {!r.reflection_done && <a className="btn btn-secondary" href={`/c/${r.conversation_id}/reflect`}>Reflect</a>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {ended.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold text-lg">Ended chats</h2>
          <ul className="space-y-3" aria-label="Ended chats">
            {ended.map((c) => (
              <li key={c.connection_id} className="card flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="font-semibold">{c.peer_alias}</p>
                  <p className="muted text-xs">ended · history readable for 30 days</p>
                </div>
                <a className="btn btn-secondary" href={`/c/${c.conversation_id}`}>View history</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <button className="btn btn-ghost" disabled={refreshing} onClick={() => reload(true)}>{refreshing ? "Refreshing…" : "Refresh"}</button>
    </div>
  );
}
