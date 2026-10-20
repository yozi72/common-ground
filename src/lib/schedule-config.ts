// Server-side access to the shared session schedule stored in policy_config.
import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { DEFAULT_SCHEDULE, isValidTimeZone, type ScheduleConfig } from "@/lib/schedule";

export async function getScheduleConfig(): Promise<ScheduleConfig> {
  const { data } = await supabaseAdmin().from("policy_config").select("key, value")
    .in("key", ["session_days", "session_start_time", "session_duration_minutes", "session_timezone"]);
  const m = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  const days = Array.isArray(m.session_days) ? (m.session_days as number[]).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : DEFAULT_SCHEDULE.days;
  const startTime = typeof m.session_start_time === "string" && /^\d{2}:\d{2}$/.test(m.session_start_time) ? m.session_start_time : DEFAULT_SCHEDULE.startTime;
  const durationMinutes = Number(m.session_duration_minutes) > 0 ? Number(m.session_duration_minutes) : DEFAULT_SCHEDULE.durationMinutes;
  const timezone = typeof m.session_timezone === "string" && isValidTimeZone(m.session_timezone) ? m.session_timezone : DEFAULT_SCHEDULE.timezone;
  return { days, startTime, durationMinutes, timezone };
}

// Server clock for dynamic pages (they render per request, so this is stable within one render).
export function serverNow() { return Date.now(); }
