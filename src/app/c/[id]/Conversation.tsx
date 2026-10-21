"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { TwoCups } from "@/components/Illustrations";

type Conv = { id: string; status: "opening" | "chatting" | "ended"; opening_question_count: number; questions_asked: number; end_reason: string | null; kind?: "live" | "friend" };
type Question = { id: string; seq: number; phase: "opening" | "mid"; question_text: string; choices: string[]; status: "open" | "revealed" | "closed"; created_at: string; revealed_at: string | null };
type Answer = { question_id: string; participant_id: string; choice_index: number | null; custom_text: string | null; status: string };
type Msg = { id: string; sender_participant_id: string; kind: "chat" | "answer"; body: string; created_at: string };
type Pending = { id: string; client_send_id: string; kind: "chat" | "answer"; question_id: string | null; body: string; status: string; user_explanation: string | null; suggested_revision: string | null; created_at: string; attempts: number };

const PENDING_CANCEL_AFTER_MS = 45_000;

export function Conversation({ conversationId, myParticipantId, myAlias, peerAlias, peerBadges = [], kind = "live", connectionId = null, initialMuted = false }: { conversationId: string; myParticipantId: string; myAlias: string; peerAlias: string; peerBadges?: string[]; kind?: "live" | "friend"; connectionId?: string | null; initialMuted?: boolean }) {
  const router = useRouter();
  const [conv, setConv] = useState<Conv | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [partnerAway, setPartnerAway] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [confirming, setConfirming] = useState<"leave" | "block" | "unfriend" | null>(null);
  const [muted, setMuted] = useState(initialMuted);
  const isFriend = kind === "friend";
  const [now, setNow] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const sb = supabaseBrowser();
    const [c, q, a, m, p, n] = await Promise.all([
      sb.from("conversations").select("id, status, opening_question_count, questions_asked, end_reason, kind").eq("id", conversationId).maybeSingle(),
      sb.from("conversation_questions").select("id, seq, phase, question_text, choices, status, created_at, revealed_at").eq("conversation_id", conversationId).order("seq"),
      sb.from("question_answers").select("question_id, participant_id, choice_index, custom_text, status").eq("conversation_id", conversationId),
      sb.from("approved_messages").select("id, sender_participant_id, kind, body, created_at").eq("conversation_id", conversationId).order("created_at"),
      sb.from("pending_messages").select("id, client_send_id, kind, question_id, body, status, user_explanation, suggested_revision, created_at, attempts").eq("conversation_id", conversationId).order("created_at"),
      sb.from("notifications").select("id").eq("kind", "partner_away").contains("payload", { conversation_id: conversationId }).limit(1),
    ]);
    if (c.data) setConv(c.data as Conv);
    setQuestions((q.data ?? []) as Question[]);
    setAnswers((a.data ?? []) as Answer[]);
    setMessages((m.data ?? []) as Msg[]);
    setPending((p.data ?? []) as Pending[]);
    setPartnerAway(!!n.data?.length);
    if (c.data?.status === "ended" && c.data?.kind !== "friend") router.push(`/c/${conversationId}/reflect`);
    if (c.data?.kind === "friend" && c.data?.status !== "ended") fetch(`/api/conversations/${conversationId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read" }) }).catch(() => {});
  }, [conversationId, router]);

  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);

  // Realtime (RLS-filtered) + polling fallback + heartbeat.
  useEffect(() => {
    const sb = supabaseBrowser();
    const ch = sb.channel(`conv:${conversationId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "approved_messages", filter: `conversation_id=eq.${conversationId}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversation_questions", filter: `conversation_id=eq.${conversationId}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "question_answers", filter: `conversation_id=eq.${conversationId}` }, load)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversations", filter: `id=eq.${conversationId}` }, load)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, load)
      .subscribe();
    const poll = setInterval(load, 5000);
    const hb = setInterval(() => { if (!isFriend) fetch(`/api/conversations/${conversationId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "heartbeat" }) }); }, 30_000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const clock0 = setTimeout(() => setNow(Date.now()), 0);
    return () => { sb.removeChannel(ch); clearInterval(poll); clearInterval(hb); clearInterval(clock); clearTimeout(clock0); };
  }, [conversationId, load, isFriend]);

  // Faster polling while something of mine is still being checked.
  const hasLivePending = pending.some((p) => p.status === "pending");
  useEffect(() => {
    if (!hasLivePending) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [hasLivePending, load]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [messages.length, questions.length]);

  async function api(url: string, body: unknown) {
    setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { setError(json.error ?? "Something went wrong"); return null; }
    return json;
  }

  const openQuestion = questions.find((q) => q.status === "open") ?? null;
  const myAnswerFor = (qid: string) => answers.find((a) => a.question_id === qid && a.participant_id === myParticipantId);
  const peerAnswerFor = (qid: string) => answers.find((a) => a.question_id === qid && a.participant_id !== myParticipantId);

  const timeline = useMemo(() => {
    const items: { key: string; at: string; node: React.ReactNode }[] = [];
    for (const q of questions.filter((q) => q.status !== "open")) {
      items.push({ key: `q${q.id}`, at: q.revealed_at ?? q.created_at, node: <RevealedQuestion q={q} mine={myAnswerFor(q.id)} theirs={peerAnswerFor(q.id)} myAlias={myAlias} peerAlias={peerAlias} /> });
    }
    for (const m of messages.filter((m) => m.kind === "chat")) {
      const mine = m.sender_participant_id === myParticipantId;
      items.push({ key: m.id, at: m.created_at, node: <Bubble mine={mine} alias={mine ? myAlias : peerAlias} body={m.body} at={m.created_at} /> });
    }
    return items.sort((a, b) => a.at.localeCompare(b.at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questions, messages, answers]);

  if (!conv) return <p className="muted">Loading…</p>;

  return (
    <div className="flex flex-col gap-4 min-h-[70dvh]">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex -space-x-2">
            <Avatar alias={myAlias} />
            <Avatar alias={peerAlias} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold truncate">{isFriend ? `Friend chat · ${peerAlias}` : `You & ${peerAlias}`}</h1>
            <p className="muted text-xs">You're {myAlias}. {isFriend ? (conv.status === "ended" ? "This friendship has ended; history only." : muted ? "Muted · messages are checked before delivery · deleted 30 days after sending" : "Messages are checked before delivery · deleted 30 days after sending") : conv.status === "opening" ? `Question ${Math.min(conv.questions_asked, conv.opening_question_count)} of ${conv.opening_question_count}` : "Open conversation"}</p>
            {peerBadges.length > 0 && (
              <ul className="flex flex-wrap gap-1 mt-1" aria-label={`About ${peerAlias}`}>
                {peerBadges.map((b) => <li key={b} className="badge">{b}</li>)}
              </ul>
            )}
          </div>
        </div>
        <div className="relative">
          <button className="btn btn-secondary" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>Options</button>
          {menuOpen && (
            <ul role="menu" className="card absolute right-0 mt-1 w-56 p-1 z-10 text-sm shadow-lg">
              <li><button role="menuitem" className="btn btn-ghost w-full justify-start" onClick={() => { setMenuOpen(false); setReporting(true); }}>Report</button></li>
              <li><button role="menuitem" className="btn btn-ghost w-full justify-start" onClick={() => { setMenuOpen(false); setConfirming("block"); }}>Block and end</button></li>
              {isFriend ? (
                <>
                  {conv.status !== "ended" && <li><button role="menuitem" className="btn btn-ghost w-full justify-start" onClick={async () => { setMenuOpen(false); const r = await api(`/api/conversations/${conversationId}`, { action: "mute", muted: !muted }); if (r) setMuted(!muted); }}>{muted ? "Unmute notifications" : "Mute notifications"}</button></li>}
                  {conv.status !== "ended" && <li><button role="menuitem" className="btn btn-ghost w-full justify-start" onClick={() => { setMenuOpen(false); setConfirming("unfriend"); }}>Remove friend</button></li>}
                </>
              ) : (
                <li><button role="menuitem" className="btn btn-ghost w-full justify-start" onClick={() => { setMenuOpen(false); setConfirming("leave"); }}>Leave conversation</button></li>
              )}
            </ul>
          )}
        </div>
      </header>

      {!isFriend && conv.status === "opening" && (
        <div className="progress" role="progressbar" aria-label="Opening questions" aria-valuemin={0} aria-valuemax={conv.opening_question_count} aria-valuenow={Math.max(0, conv.questions_asked - 1)}>
          <div className="progress-fill" style={{ width: `${Math.round((Math.max(0, conv.questions_asked - 1) / conv.opening_question_count) * 100)}%` }} />
        </div>
      )}
      {!isFriend && conv.status === "chatting" && timeline.length > 0 && !openQuestion && (
        <p className="text-center text-xs muted">Chat is open. A new shared question will come along now and then.</p>
      )}

      {error && <div className="notice notice-bad" role="alert">{error}</div>}
      {partnerAway && <div className="notice notice-warn" role="status">{peerAlias} hasn't been active for a couple of minutes. They may have stepped away.</div>}

      {confirming && (
        <section className="card space-y-3" role="alertdialog" aria-labelledby="confirm-title">
          <h2 id="confirm-title" className="font-medium">{confirming === "block" ? "Block this person and end the conversation?" : confirming === "unfriend" ? `Remove ${peerAlias} as a friend?` : "End this conversation?"}</h2>
          <p className="muted text-sm">{confirming === "block" ? "You won't be matched with them again, and they won't be told who blocked them. This can't be undone." : confirming === "unfriend" ? "Neither of you can send new messages. Existing messages stay readable until they expire. This can't be undone." : `${peerAlias} will be told the conversation ended. You'll both get a chance to reflect.`}</p>
          <div className="flex gap-2">
            <button className={confirming === "leave" ? "btn btn-primary" : "btn btn-danger"} onClick={async () => {
              if (confirming === "unfriend") { const r = await api(`/api/conversations/${conversationId}`, { action: "remove_friend", connection_id: connectionId }); if (r) { setConfirming(null); await load(); } return; }
              const r = await api(`/api/conversations/${conversationId}`, { action: confirming }); if (r) router.push(isFriend ? "/connections" : `/c/${conversationId}/reflect`);
            }}>{confirming === "block" ? "Block and end" : confirming === "unfriend" ? "Remove friend" : "End conversation"}</button>
            <button className="btn btn-secondary" onClick={() => setConfirming(null)}>Keep talking</button>
          </div>
        </section>
      )}

      {reporting && <ReportForm onClose={() => setReporting(false)} onSubmit={async (b) => { const r = await api(`/api/conversations/${conversationId}`, { action: "report", ...b }); if (r) { setReporting(false); if (b.also_block) router.push(`/c/${conversationId}/reflect`); } }} />}

      <section aria-label="Conversation" className="flex-1 space-y-3 pb-4">
        {timeline.length === 0 && (
          <div className="text-center py-6 space-y-2">
            <TwoCups className="w-36 h-auto mx-auto float" />
            {isFriend ? (
              <>
                <p className="font-semibold">Say hello whenever you like</p>
                <p className="muted text-sm max-w-sm mx-auto">{peerAlias} doesn&apos;t need to be online; they&apos;ll see it when they&apos;re back. Want a shared question to get going? Use &ldquo;Give us a question&rdquo; below.</p>
              </>
            ) : openQuestion ? (
              <>
                <p className="font-semibold">Ten shared questions to start</p>
                <p className="muted text-sm max-w-sm mx-auto">You both get the same question. Answers stay hidden until you&apos;ve both answered, then appear together here.</p>
              </>
            ) : (
              <p className="muted text-sm">Getting your first question ready…</p>
            )}
          </div>
        )}
        {timeline.map((t) => <div key={t.key}>{t.node}</div>)}
        <div ref={bottomRef} />
      </section>

      {openQuestion && (
        <QuestionCard q={openQuestion} mine={myAnswerFor(openQuestion.id)} peerAlias={peerAlias} peerAnswered={!!peerAnswerFor(openQuestion.id)}
          pendingAnswer={pending.find((p) => p.question_id === openQuestion.id && !["approved", "cancelled"].includes(p.status)) ?? null}
          onChoice={(i) => api(`/api/questions/${openQuestion.id}`, { action: "choice", choice: i, conversation_id: conversationId }).then(load)}
          onSkip={() => api(`/api/questions/${openQuestion.id}`, { action: "skip", conversation_id: conversationId }).then(load)}
          onCustom={(text) => api("/api/messages", { conversation_id: conversationId, client_send_id: crypto.randomUUID(), body: text, kind: "answer", question_id: openQuestion.id }).then(load)}
          onPendingAction={(id, action) => api(`/api/messages/${id}`, { action }).then(load)}
          now={now}
        />
      )}

      {isFriend && conv.status === "ended" && (
        <p className="notice notice-warn text-sm" role="status">{conv.end_reason === "blocked" ? "This conversation was ended with a block." : "This friendship has ended. No new messages can be sent; what's here stays readable until it expires."}</p>
      )}
      {isFriend && conv.status !== "ended" && !openQuestion && (
        <div className="flex justify-center">
          <button className="btn btn-secondary text-sm" onClick={async () => { const r = await api(`/api/conversations/${conversationId}`, { action: "question" }); if (r && !r.created) setError("No new question right now; try again in a bit."); await load(); }}>Give us a question</button>
        </div>
      )}
      {conv.status === "chatting" && (
        <Composer conversationId={conversationId} pending={pending.filter((p) => p.kind === "chat" && !["approved", "cancelled"].includes(p.status))}
          onSent={load} onPendingAction={(id, action, note) => api(`/api/messages/${id}`, { action, note }).then(load)} api={api} now={now} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Bubble({ mine, alias, body, at }: { mine: boolean; alias: string; body: string; at: string }) {
  return (
    <div className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"}`}>
      {!mine && <Avatar alias={alias} small />}
      <div className="max-w-[80%] px-4 py-2.5" style={{ background: mine ? "var(--mine)" : "var(--theirs)", borderRadius: mine ? "20px 20px 6px 20px" : "20px 20px 20px 6px" }}>
        <div className="text-xs muted mb-0.5">{alias} · {new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
        <div className="whitespace-pre-wrap break-words">{body}</div>
      </div>
    </div>
  );
}

// Deterministic warm color per alias; never a political color pair.
function Avatar({ alias, small = false }: { alias: string; small?: boolean }) {
  const palettes = ["var(--accent-2)", "var(--sage-2)", "var(--sun-2)", "var(--theirs)", "var(--mine)"];
  let h = 0;
  for (const ch of alias) h = (h * 31 + ch.charCodeAt(0)) % 997;
  const bg = palettes[h % palettes.length];
  const initials = alias.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return <span className={`avatar ${small ? "avatar-sm" : ""}`} style={{ background: bg, border: "2px solid var(--card)" }} aria-hidden="true">{initials}</span>;
}

function answerText(q: Question, a?: Answer) {
  if (!a) return "No answer";
  if (a.status === "skipped") return "Skipped this one";
  if (a.choice_index != null) return q.choices[a.choice_index];
  return a.custom_text ?? "…";
}

function RevealedQuestion({ q, mine, theirs, myAlias, peerAlias }: { q: Question; mine?: Answer; theirs?: Answer; myAlias: string; peerAlias: string }) {
  const a = answerText(q, mine), b = answerText(q, theirs);
  const same = mine && theirs && mine.status === "approved" && theirs.status === "approved" && a === b;
  return (
    <section className="card-flat space-y-3" aria-label={`Question ${q.seq}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">Question {q.seq}</span>
        {same && <span className="badge">Same answer</span>}
      </div>
      <p className="font-semibold">{q.question_text}</p>
      {q.status === "closed" && !q.revealed_at ? (
        <p className="muted text-sm">This one closed before you both answered, so answers stay private.</p>
      ) : (
        <dl className="grid gap-2 sm:grid-cols-2 text-sm">
          <div className="flex gap-2 items-start rounded-xl p-3" style={{ background: "var(--mine)" }}><Avatar alias={myAlias} small /><div><dt className="text-xs muted">{myAlias}</dt><dd>{a}</dd></div></div>
          <div className="flex gap-2 items-start rounded-xl p-3" style={{ background: "var(--theirs)" }}><Avatar alias={peerAlias} small /><div><dt className="text-xs muted">{peerAlias}</dt><dd>{b}</dd></div></div>
        </dl>
      )}
    </section>
  );
}

function QuestionCard({ q, mine, peerAlias, peerAnswered, pendingAnswer, onChoice, onSkip, onCustom, onPendingAction, now }: {
  q: Question; mine?: Answer; peerAlias: string; peerAnswered: boolean; pendingAnswer: Pending | null;
  onChoice: (i: number) => void; onSkip: () => void; onCustom: (t: string) => void; onPendingAction: (id: string, action: "cancel" | "accept_revision" | "appeal") => void; now: number;
}) {
  const [custom, setCustom] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const answered = mine && (mine.status === "approved" || mine.status === "skipped");

  return (
    <section className="card space-y-3 sm:sticky sm:bottom-2" aria-live="polite" aria-label="Current question" style={{ borderColor: "var(--accent)" }}>
      <p className="eyebrow">{q.phase === "opening" ? `Question ${q.seq}` : "A question for both of you"}</p>
      <p className="font-semibold text-xl">{q.question_text}</p>
      {answered ? (
        <p className="notice notice-ok">Answered. {peerAnswered ? "Revealing…" : `Waiting for ${peerAlias}. You'll both see each other's answers at the same time.`}</p>
      ) : pendingAnswer ? (
        <PendingItem p={pendingAnswer} now={now} onAction={onPendingAction} />
      ) : (
        <>
          <div className="grid gap-2">
            {q.choices.map((c, i) => (
              <button key={i} className="option" onClick={() => onChoice(i)}>{c}</button>
            ))}
            {!showCustom && <button className="option muted" onClick={() => setShowCustom(true)}>Write my own answer…</button>}
          </div>
          {showCustom && (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) { onCustom(custom.trim()); setCustom(""); setShowCustom(false); } }}>
              <label className="sr-only" htmlFor="custom-answer">Your answer</label>
              <textarea id="custom-answer" className="field" rows={3} maxLength={600} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="In your own words. It's checked before the other person sees it." />
              <div className="flex gap-2"><button className="btn btn-primary" disabled={!custom.trim()}>Send answer</button><button type="button" className="btn btn-ghost" onClick={() => setShowCustom(false)}>Back</button></div>
            </form>
          )}
          <button className="btn btn-ghost text-sm" onClick={onSkip}>Skip this question</button>
        </>
      )}
    </section>
  );
}

function PendingItem({ p, now, onAction }: { p: Pending; now: number; onAction: (id: string, action: "cancel" | "accept_revision" | "appeal", note?: string) => void }) {
  const age = now - new Date(p.created_at).getTime();
  const slow = p.status === "pending" && age > PENDING_CANCEL_AFTER_MS;
  const [appealing, setAppealing] = useState(false);
  const [note, setNote] = useState("");
  const [appealed, setAppealed] = useState(false);
  const appealBox = appealed ? (
    <p className="text-xs" role="status">Appeal sent. A reviewer will look at it; the message stays undelivered unless they overturn the decision.</p>
  ) : appealing ? (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); onAction(p.id, "appeal", note); setAppealed(true); setAppealing(false); }}>
      <label className="block text-xs" htmlFor={`appeal-${p.id}`}>Tell the reviewer why this should be delivered (optional)</label>
      <textarea id={`appeal-${p.id}`} className="field text-sm" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2"><button className="btn btn-primary text-xs px-3 py-1.5 min-h-0">Send appeal</button><button type="button" className="btn btn-ghost text-xs px-3 py-1.5 min-h-0" onClick={() => setAppealing(false)}>Back</button></div>
    </form>
  ) : null;
  return (
    <div className="rounded-xl px-3 py-2 text-sm space-y-2" style={{ background: "var(--mine)", opacity: p.status === "pending" ? 0.8 : 1 }} role="status">
      <div className="whitespace-pre-wrap break-words">{p.body}</div>
      {p.status === "pending" && (
        <div className="flex items-center justify-between gap-2 muted text-xs">
          <span>{slow ? "Still checking. The review service is slow right now; you can keep waiting or cancel." : "Checking before delivery…"}</span>
          {slow && <button className="btn btn-ghost text-xs px-2 py-1 min-h-0" onClick={() => onAction(p.id, "cancel")}>Cancel</button>}
        </div>
      )}
      {p.status === "review" && (
        <div className="notice notice-warn space-y-1">
          <p>{p.user_explanation ?? "Held for a human review."} The other person can't see it. We'll deliver it if a reviewer approves.</p>
          <button className="btn btn-ghost text-xs px-2 py-1 min-h-0" onClick={() => onAction(p.id, "cancel")}>Withdraw</button>
        </div>
      )}
      {p.status === "revise" && (
        <div className="notice notice-warn space-y-2">
          <p>Not delivered. {p.user_explanation}</p>
          {p.suggested_revision && (
            <div className="rounded-lg p-2 text-sm" style={{ background: "var(--card)" }}>
              <p className="text-xs muted mb-1">Suggested rewording (sent only if you accept):</p>
              <p>{p.suggested_revision}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {p.suggested_revision && <button className="btn btn-primary text-xs px-3 py-1.5 min-h-0" onClick={() => onAction(p.id, "accept_revision")}>Send this version</button>}
            <button className="btn btn-secondary text-xs px-3 py-1.5 min-h-0" onClick={() => onAction(p.id, "cancel")}>Discard</button>
            {!appealed && <button className="btn btn-ghost text-xs px-3 py-1.5 min-h-0" onClick={() => setAppealing(true)}>Appeal</button>}
          </div>
          {appealBox}
        </div>
      )}
      {p.status === "blocked" && (
        <div className="notice notice-bad space-y-2">
          <p>Not delivered. {p.user_explanation}</p>
          <div className="flex gap-2">
            <button className="btn btn-secondary text-xs px-3 py-1.5 min-h-0" onClick={() => onAction(p.id, "cancel")}>Dismiss</button>
            {!appealed && <button className="btn btn-ghost text-xs px-3 py-1.5 min-h-0" onClick={() => setAppealing(true)}>Appeal</button>}
          </div>
          {appealBox}
        </div>
      )}
      {p.status === "failed" && <div className="notice notice-bad">Couldn't be checked. <button className="underline" onClick={() => onAction(p.id, "cancel")}>Discard</button></div>}
    </div>
  );
}

function Composer({ conversationId, pending, onSent, onPendingAction, api, now }: {
  conversationId: string; pending: Pending[]; onSent: () => void;
  onPendingAction: (id: string, action: "cancel" | "accept_revision" | "appeal", note?: string) => void;
  api: (url: string, body: unknown) => Promise<unknown>; now: number;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setSending(true);
    const r = await api("/api/messages", { conversation_id: conversationId, client_send_id: crypto.randomUUID(), body });
    setSending(false);
    if (r) { setText(""); onSent(); }
  }

  return (
    <div className="sticky bottom-[68px] sm:bottom-0 pb-2 space-y-2" style={{ background: "var(--bg)" }}>
      {pending.map((p) => <PendingItem key={p.id} p={p} now={now} onAction={onPendingAction} />)}
      <form onSubmit={send} className="flex gap-2 items-end">
        <label className="sr-only" htmlFor="composer">Message</label>
        <textarea id="composer" className="field flex-1" rows={1} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }}
          placeholder="Write a message…" style={{ borderRadius: 24, resize: "none" }} />
        <button className="btn btn-primary px-0 w-12 h-12 min-h-0 shrink-0" disabled={sending || !text.trim()} aria-label="Send">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </form>
      <p className="text-center text-[11px] muted">Messages are checked before the other person sees them.</p>
    </div>
  );
}

function ReportForm({ onClose, onSubmit }: { onClose: () => void; onSubmit: (b: { reason: string; details: string; also_block: boolean }) => void }) {
  const [reason, setReason] = useState("harassment");
  const [details, setDetails] = useState("");
  const [alsoBlock, setAlsoBlock] = useState(false);
  return (
    <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); onSubmit({ reason, details, also_block: alsoBlock }); }} aria-label="Report this conversation">
      <h2 className="font-medium">Report</h2>
      <p className="muted text-sm">A human reviewer will look at recent messages in this conversation. The other person isn't told who reported.</p>
      <label className="block text-sm" htmlFor="reason">Reason</label>
      <select id="reason" className="field" value={reason} onChange={(e) => setReason(e.target.value)}>
        <option value="harassment">Harassment or insults</option>
        <option value="threat">Threat</option>
        <option value="hate">Hateful or dehumanizing</option>
        <option value="identity_fishing">Trying to get my personal details</option>
        <option value="spam">Spam</option>
        <option value="other">Something else</option>
      </select>
      <label className="block text-sm" htmlFor="details">Details (optional)</label>
      <textarea id="details" className="field" rows={3} value={details} onChange={(e) => setDetails(e.target.value)} />
      <label className="flex gap-2 items-center text-sm"><input type="checkbox" className="h-5 w-5" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} /> Also block and end the conversation</label>
      <div className="flex gap-2"><button className="btn btn-primary">Send report</button><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button></div>
    </form>
  );
}
