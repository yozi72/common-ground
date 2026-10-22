import { z } from "zod";
import { handle, ok, parseBody, requireUser, fromRpcError, ApiError } from "@/lib/api";
import { env } from "@/lib/env";
import { isValidTimeZone } from "@/lib/schedule";
import { isAllowedPushEndpoint } from "@/lib/push-endpoint";
import { getScheduleConfig } from "@/lib/schedule-config";
import { pickNextReminderSession } from "@/lib/schedule";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("prefs"),
    push_enabled: z.boolean().optional(),
    email_enabled: z.boolean().optional(),
    friend_push_enabled: z.boolean().optional(),
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
        if ((b.friend_push_enabled || b.push_enabled) && !env.pushConfigured()) throw new ApiError(409, "Phone notifications aren't set up on this server yet");
        if (b.mode === "weekdays" && (!b.days || b.days.length === 0)) throw new ApiError(400, "Pick at least one day");
        const patch: Record<string, unknown> = Object.fromEntries(Object.entries(b).filter(([k, v]) => k !== "action" && v !== undefined));
        // "next session only": the server picks the next session whose reminder time hasn't passed (never a client timestamp)
        if (b.mode === "next") {
          const cfg = await getScheduleConfig();
          const target = pickNextReminderSession(Date.now(), b.minutes_before ?? 10, cfg);
          if (!target) throw new ApiError(409, "There's no upcoming session to remind you about yet");
          patch.next_session_start = new Date(target.start).toISOString();
        } else {
          delete patch.next_session_start;
        }
        const { error } = await supabase.from("reminder_prefs").upsert({ account_id: user.id, ...patch, updated_at: new Date().toISOString() }, { onConflict: "account_id" });
        if (error) throw fromRpcError(error);
        if (b.email_enabled !== undefined || b.push_enabled !== undefined) {
          await supabase.rpc("record_consent", { p_kind: "reminders", p_version: "v1", p_granted: !!(b.email_enabled || b.push_enabled) });
        }
        if (b.friend_push_enabled !== undefined) {
          await supabase.rpc("record_consent", { p_kind: "friend_push", p_version: "v1", p_granted: b.friend_push_enabled });
        }
        return ok({ next_session_start: (patch.next_session_start as string | undefined) ?? null });
      }
      case "subscribe": {
        if (!env.pushConfigured()) throw new ApiError(409, "Phone notifications aren't set up on this server yet");
        if (!isAllowedPushEndpoint(b.endpoint)) throw new ApiError(400, "This browser's push service isn't supported");
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

// The public VAPID key (public by definition) so a service worker can
// re-subscribe after the browser rotated its push subscription.
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("vapid") !== "1") return new Response(null, { status: 404 });
  return Response.json({ key: env.pushConfigured() ? process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null : null }, { headers: { "Cache-Control": "no-store" } });
}
