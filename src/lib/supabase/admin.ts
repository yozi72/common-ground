// Service-role client. Bypasses RLS. Only for workers and the few routes that
// must act across users (moderation enforcement, matching, deletion).
import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

export function supabaseAdmin() {
  return createClient(env.supabaseUrl(), env.supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
