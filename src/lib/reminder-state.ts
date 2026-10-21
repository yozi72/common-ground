// Pure helpers for reminder preference state (shared by UI and tests).
export type SavedPrefs = { mode: "next" | "weekdays" | "daily"; next_session_start: string | null; email_enabled: boolean; push_enabled: boolean };

// A "next session only" reminder is spent once its session has started.
export function nextOnlyExpired(saved: SavedPrefs | null, nowMs: number): boolean {
  if (!saved || saved.mode !== "next") return false;
  if (!saved.email_enabled && !saved.push_enabled) return false;
  if (!saved.next_session_start) return true;
  return Date.parse(saved.next_session_start) <= nowMs;
}
