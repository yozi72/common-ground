import { z } from "zod";
import { handle, ok, parseBody, requireUser, fromRpcError, ApiError } from "@/lib/api";
import { env } from "@/lib/env";
import { isValidTimeZone } from "@/lib/schedule";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("prefs"),
    push_enabled: z.boolean().optional(),
    email_enabled: z.boolean().optional(),
    mode: z.enum(["next", "weekdays", "daily"]).optional(),
    days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    next_session_start: z.string().datetime().nullable().optional(),
    minutes_before: z.number().int().min(1).max(120).optional(),
    timezone: z.string().max(64).nullable().optional(),
  }),
  z.object({ action: z.literal("subscribe"), endpoint: z.string().url().max(2000), p256dh: z.string().min(10).max(500), auth: z.string().min(5).max(200) }),
  z.object({ action: z.literal("unsubscribe"), endpoint: z.string().url().max(2000) }),
  z.object({ action: z.literal("timezone"), timezone: z.string().max(64).nullable() }),
]);

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const b = await parseBody(req, Body);
    switch (b.action) {
      case "prefs": {
        if (b.push_enabled && !env.pushConfigured()) throw new ApiError(409, "Phone notifications aren't set up on this server yet");
        if (b.email_enabled && !env.emailConfigured()) throw new ApiError(409, "Email reminders aren't set up on this server yet");
        if (b.timezone && !isValidTimeZone(b.timezone)) throw new ApiError(400, "Unknown timezone");
        const patch = Object.fromEntries(Object.entries(b).filter(([k, v]) => k !== "action" && v !== undefined));
        const { error } = await supabase.from("reminder_prefs").upsert({ account_id: user.id, ...patch, updated_at: new Date().toISOString() }, { onConflict: "account_id" });
        if (error) throw fromRpcError(error);
        if (b.email_enabled !== undefined || b.push_enabled !== undefined) {
          await supabase.from("consent_events").insert({ account_id: user.id, kind: "reminders", version: "v1", granted: !!(b.email_enabled || b.push_enabled) });
        }
        return ok();
      }
      case "subscribe": {
        if (!env.pushConfigured()) throw new ApiError(409, "Phone notifications aren't set up on this server yet");
        const { data, error } = await supabase.rpc("upsert_push_subscription", { p_endpoint: b.endpoint, p_p256dh: b.p256dh, p_auth: b.auth, p_user_agent: req.headers.get("user-agent") ?? "" });
        if (error) throw fromRpcError(error);
        return ok({ id: data });
      }
      case "unsubscribe": {
        const { error } = await supabase.rpc("remove_push_subscription", { p_endpoint: b.endpoint });
        if (error) throw fromRpcError(error);
        return ok();
      }
      case "timezone": {
        if (b.timezone && !isValidTimeZone(b.timezone)) throw new ApiError(400, "Unknown timezone");
        const { error } = await supabase.from("profiles").update({ timezone_override: b.timezone }).eq("account_id", user.id);
        if (error) throw fromRpcError(error);
        return ok();
      }
    }
  });
}
