// Pure helpers for the sender's held messages (revise / blocked / cancelled-
// after-appeal) and their appeal outcomes. Shared by the chat screen, the
// reflection page and the tests.
export type HeldMessage = {
  id: string; kind: "chat" | "answer"; body: string; status: "revise" | "blocked" | "cancelled" | string;
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
