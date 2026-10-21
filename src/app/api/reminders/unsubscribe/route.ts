import { NextResponse } from "next/server";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

// One-click unsubscribe from reminder emails (link in every reminder email).
// Public by design: the token is the authorization. Only email is turned off.
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("t") ?? "";
  const accountId = verifyUnsubscribeToken(token);
  const site = env.siteUrl();
  if (!accountId) return page("That unsubscribe link isn't valid.", "You can manage reminders under Profile → Reminders after signing in.", site, 400);
  const admin = supabaseAdmin();
  await admin.from("reminder_prefs").upsert({ account_id: accountId, email_enabled: false, updated_at: new Date().toISOString() }, { onConflict: "account_id" });
  await admin.from("consent_events").insert({ account_id: accountId, kind: "reminders_email", version: "v1", granted: false });
  return page("Email reminders are off.", "You won't get reminder emails for the conversation hour. You can turn them back on any time under Profile → Reminders.", site, 200);
}

function page(title: string, body: string, site: string, status: number) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#fbf7f0;color:#2a2520;margin:0;padding:2rem 1rem;display:flex;justify-content:center}main{max-width:28rem;background:#fff;border:1px solid #ebe2d3;border-radius:22px;padding:1.5rem}a{color:#e2745a}</style></head>
<body><main><h1 style="font-size:1.4rem;margin:0 0 .5rem">${title}</h1><p>${body}</p><p><a href="${site}/settings#reminders">Open Common Ground</a></p></main></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
