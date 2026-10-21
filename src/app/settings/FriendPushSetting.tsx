"use client";
import { useState } from "react";

// Separate consent from session reminders: a session-reminder opt-in never
// implies friend-message notifications.
export function FriendPushSetting({ initial, pushAvailable }: { initial: boolean; pushAvailable: boolean }) {
  const [on, setOn] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  async function save(v: boolean) {
    setMsg(null);
    const res = await fetch("/api/reminders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "prefs", friend_push_enabled: v }) });
    if (!res.ok) { setMsg((await res.json().catch(() => ({}))).error ?? "Couldn't save"); return; }
    setOn(v); setMsg(v ? "Chat notifications are on. You'll get “You have a new message” on devices you've enabled above." : "Chat notifications are off.");
  }
  return (
    <section className="card space-y-2 text-sm">
      <h2 className="font-semibold">Chat messages</h2>
      <p className="muted">A neutral phone notification (&ldquo;You have a new message&rdquo;) when someone writes to you in one of your chats, at most one per chat every 10 minutes. Nothing about the message or the sender is shown. Mute individual chats from their Options menu.</p>
      {pushAvailable ? (
        <label className="flex gap-3 items-center cursor-pointer">
          <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={on} onChange={(e) => save(e.target.checked)} />
          <span>Notify me about new chat messages</span>
        </label>
      ) : <p className="muted">Phone notifications aren&apos;t set up on this server yet.</p>}
      {msg && <p className="notice notice-ok" role="status">{msg}</p>}
    </section>
  );
}
