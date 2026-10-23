// Pure helpers for the sender's held messages (revise / blocked / cancelled-
// after-appeal) and their appeal outcomes. Shared by the chat screen, the
// reflection page and the tests.
export type HeldMessage = {
  id: string; kind: "chat" | "answer"; question_id?: string | null; body: string; status: "revise" | "blocked" | "cancelled" | string;
  user_explanation: string | null; suggested_revision: string | null; undeliverable_reason: string | null; created_at: string;
  appeal_id: string | null; appeal_status: "open" | "upheld" | "overturned" | string | null; appeal_note: string | null;
  appeal_resolution_note: string | null; appeal_created_at: string | null; appeal_resolved_at: string | null;
};

// Why a decided message can no longer be sent. The reason is the one recorded
// at the time (left / abandoned / blocked / unfriended / cleared), never a
// generic substitute.
export function undeliverableText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  switch (reason) {
    case "cleared": return "This chat's history was cleared, so this can't be sent now.";
    case "unfriended": return "This chat has ended, so this can't be sent now.";
    case "blocked": return "This conversation was ended with a block, so this can't be sent now.";
    case "left": case "abandoned": return "This conversation has ended, so this can't be sent now.";
    default: return "This can't be sent now.";
  }
}

export type AppealOutcome =
  | { state: "none"; canAppeal: boolean }
  | { state: "open"; note: string | null; since: string | null }
  | { state: "upheld"; note: string | null; resolutionNote: string | null }
  | { state: "overturned"; delivered: boolean; explanation: string | null; resolutionNote: string | null };

export function appealOutcome(m: HeldMessage): AppealOutcome {
  if (!m.appeal_id || !m.appeal_status) return { state: "none", canAppeal: m.status === "revise" || m.status === "blocked" };
  if (m.appeal_status === "open") return { state: "open", note: m.appeal_note, since: m.appeal_created_at };
  if (m.appeal_status === "upheld") return { state: "upheld", note: m.appeal_note, resolutionNote: m.appeal_resolution_note };
  // overturned: delivered unless the row was cancelled as undeliverable (the explanation says why)
  return { state: "overturned", delivered: m.status !== "cancelled", explanation: m.user_explanation, resolutionNote: m.appeal_resolution_note };
}

export function canAcceptRevision(m: HeldMessage): boolean {
  return m.status === "revise" && !!m.suggested_revision && !m.undeliverable_reason;
}

// --- appeal form state (pure, tested) -----------------------------------------
// Success is shown only after the server accepted the appeal; a failure keeps
// the note and allows a retry; nothing can be submitted while a request is in
// flight, so a double tap cannot file twice.
export type AppealFormState = { phase: "idle" | "editing" | "sending" | "sent" | "error"; note: string; error: string | null };
export type AppealFormEvent =
  | { type: "open" } | { type: "close" } | { type: "note"; note: string }
  | { type: "submit" } | { type: "accepted" } | { type: "failed"; error: string };
export const appealFormInitial: AppealFormState = { phase: "idle", note: "", error: null };
export function appealFormReducer(s: AppealFormState, e: AppealFormEvent): AppealFormState {
  switch (e.type) {
    case "open": return s.phase === "sending" || s.phase === "sent" ? s : { ...s, phase: "editing", error: null };
    case "close": return s.phase === "sending" || s.phase === "sent" ? s : { ...s, phase: "idle", error: null };
    case "note": return s.phase === "sending" || s.phase === "sent" ? s : { ...s, note: e.note };
    case "submit": return s.phase === "editing" || s.phase === "error" ? { ...s, phase: "sending", error: null } : s;   // never from sending/sent
    case "accepted": return s.phase === "sending" ? { ...s, phase: "sent", error: null } : s;
    case "failed": return s.phase === "sending" ? { ...s, phase: "error", error: e.error } : s;              // note preserved
  }
}

// Bounded refresh: held outcomes are re-fetched only while an appeal is open.
export function heldNeedsRefresh(rows: HeldMessage[]): boolean {
  return rows.some((m) => m.appeal_status === "open");
}

// --- pending-row polling (pure, tested) ----------------------------------------
// Fast polling (1.5 s) is for messages the worker is actively checking. A
// message deferred until the daily budget reset (next_attempt_at far ahead)
// must not keep the screen polling for hours: it falls back to the regular
// 5 s poll and realtime, and becomes "live" again when its retry time nears.
export type PollRow = { status: string; next_attempt_at?: string | null };
// Must cover the moderation claim lease (CLAIM_LEASE_SECONDS = 75 s in
// workers/moderation.ts): a claimed message's next_attempt_at sits one lease
// ahead, and it must still count as actively checked. A budget deferral sits
// hours ahead (the daily reset) and does not.
export const FAST_POLL_HORIZON_MS = 90_000;
export function fastPollDue(rows: PollRow[], nowMs: number): boolean {
  return rows.some((r) => r.status === "pending" && (!r.next_attempt_at || Date.parse(r.next_attempt_at) <= nowMs + FAST_POLL_HORIZON_MS));
}

// The held custom answer for the question on screen, never an older one.
export function heldAnswerFor(rows: HeldMessage[], questionId: string): HeldMessage | null {
  return rows.find((m) => m.kind === "answer" && m.question_id === questionId && (m.status === "revise" || m.status === "blocked")) ?? null;
}
