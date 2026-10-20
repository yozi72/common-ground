"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { TwoCups, Bridge } from "@/components/Illustrations";

type Request = { id: string; status: string; expires_at: string; notify_email: boolean } | null;
type Invitation = { id: string; kind: string; expires_at: string; my_decision: string | null };

export function Lobby({ userId, initialRequest, initialInvitations, emailAvailable = false }: { userId: string; initialRequest: Request; initialInvitations: Invitation[]; emailAvailable?: boolean }) {
  const router = useRouter();
  const [request, setRequest] = useState<Request>(initialRequest);
  const [invitations, setInvitations] = useState<Invitation[]>(initialInvitations);
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const refresh = useCallback(async () => {
    const sb = supabaseBrowser();
    const [{ data: req }, { data: inv }] = await Promise.all([
      sb.from("availability_requests").select("id, status, expires_at, notify_email").in("status", ["waiting", "invited"]).maybeSingle(),
      sb.from("invitation_participants").select("invitation_id, decision, match_invitations!inner(id, kind, status, expires_at, conversation_id)")
        .eq("account_id", userId).eq("match_invitations.status", "pending"),
    ]);
    setRequest((req as Request) ?? null);
    type Inv = { invitation_id: string; decision: string | null; match_invitations: { kind: string; expires_at: string } };
    setInvitations(((inv ?? []) as unknown as Inv[]).map((i) => ({ id: i.invitation_id, kind: i.match_invitations.kind, expires_at: i.match_invitations.expires_at, my_decision: i.decision })));
    // if a conversation opened while we were away, go there
    const { data: live } = await sb.from("participants").select("conversation_id, conversations!participants_conversation_id_fkey!inner(status)").eq("account_id", userId).is("left_at", null).neq("conversations.status", "ended").limit(1);
    if (live?.length) router.push(`/c/${live[0].conversation_id}`);
  }, [userId, router]);

  // Realtime on my notifications + polling fallback (realtime delivery is not guaranteed).
  useEffect(() => {
    const sb = supabaseBrowser();
    const ch = sb.channel(`lobby:${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `account_id=eq.${userId}` }, () => refresh())
      .subscribe();
    const poll = setInterval(() => { fetch("/api/cron/nudge", { method: "POST" }).catch(() => {}); refresh(); }, 10_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const tick0 = setTimeout(() => setNow(Date.now()), 0);
    return () => { sb.removeChannel(ch); clearInterval(poll); clearInterval(tick); clearTimeout(tick0); };
  }, [userId, refresh]);

  async function call(url: string, body: unknown) {
    setBusy(true); setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(json.error ?? "Something went wrong"); return null; }
    return json;
  }

  async function join() {
    const r = await call("/api/queue", { action: "join", notify_email: notifyEmail });
    if (r) await refresh();
  }
  async function leave() {
    const r = await call("/api/queue", { action: "leave" });
    if (r) await refresh();
  }
  async function respond(id: string, accept: boolean) {
    const r = await call(`/api/invitations/${id}`, { accept });
    if (!r) return;
    if (r.status === "opened") router.push(`/c/${r.conversation_id}`);
    else await refresh();
  }

  const secondsLeft = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold">Talk</h1>
      {error && <div className="notice notice-bad" role="alert">{error}</div>}

      {invitations.map((inv) => (
        <section key={inv.id} className="card space-y-3 pop" aria-live="polite" style={{ borderColor: "var(--accent)" }}>
          <Bridge className="w-32 h-auto mx-auto" />
          <h2 className="font-semibold text-xl text-center">{inv.kind === "reconnect" ? "Someone you connected with wants to talk again" : "We found someone"}</h2>
          <p className="muted text-sm">
            {inv.kind === "reconnect"
              ? "Accepting opens a new conversation with the same aliases as before."
              : "They answered some of the questions differently from you. That's the only thing either of you will know. The conversation opens once you both accept."}
          </p>
          <p className="text-sm" aria-live="off">Expires in {Math.floor(secondsLeft(inv.expires_at) / 60)}:{String(secondsLeft(inv.expires_at) % 60).padStart(2, "0")}</p>
          {inv.my_decision === "accepted" ? (
            <p className="notice notice-ok">You accepted. Waiting for the other person…</p>
          ) : (
            <div className="flex gap-2">
              <button className="btn btn-primary flex-1" disabled={busy} onClick={() => respond(inv.id, true)}>Accept</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => respond(inv.id, false)}>Not now</button>
            </div>
          )}
        </section>
      ))}

      {request && request.status === "waiting" && (
        <section className="card space-y-3" aria-live="polite">
          <TwoCups className="w-32 h-auto mx-auto float" />
          <h2 className="font-semibold text-xl text-center">You're on the list</h2>
          <p className="muted text-sm">
            We'll invite you when someone with different views is also waiting. This can take a while; it depends on who else is here.
            Your spot expires in about {Math.max(1, Math.round(secondsLeft(request.expires_at) / 60))} min.
            {request.notify_email ? " We'll email you when a match is ready." : " Keep this page open, or come back to check."}
          </p>
          <button className="btn btn-secondary" disabled={busy} onClick={leave}>Leave the list</button>
        </section>
      )}

      {!request && invitations.length === 0 && (
        <section className="card space-y-4">
          <TwoCups className="w-32 h-auto mx-auto" />
          <h2 className="font-semibold text-xl text-center">Ready to talk?</h2>
          <p className="muted text-sm">You'll be paired with another adult whose questionnaire answers differ from yours. You'll both get the same questions, and you can leave at any time.</p>
          {emailAvailable ? (
            <label className="flex gap-3 items-start cursor-pointer">
              <input type="checkbox" className="mt-1 h-5 w-5" checked={notifyEmail} onChange={(e) => setNotifyEmail(e.target.checked)} />
              <span className="text-sm">Email me when a match is ready (so I don't have to keep this open). Emails may take a minute or two.</span>
            </label>
          ) : (
            <p className="muted text-sm">Keep this page open while you wait; email notices aren't set up yet.</p>
          )}
          <button className="btn btn-primary w-full" disabled={busy} onClick={join}>{busy ? "Joining…" : "Join the waiting list"}</button>
        </section>
      )}
    </div>
  );
}
