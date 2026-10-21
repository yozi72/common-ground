import { NextResponse } from "next/server";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

// Unsubscribe from reminder emails (link in every reminder email). Public by
// design: the token is the authorization; no account details are shown.
//   GET  → confirmation page only; changes nothing (mail clients and link
//          scanners prefetch links).
//   POST → performs the unsubscribe: the page's form, or a mail provider's
//          RFC 8058 one-click request (body "List-Unsubscribe=One-Click").
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("t") ?? "";
  const site = env.siteUrl();
  if (!verifyUnsubscribeToken(token)) return page("That unsubscribe link isn't valid.", "<p>You can manage reminders under Profile → Reminders after signing in.</p>", site, 400);
  const form = `<form method="post" action="/api/reminders/unsubscribe"><input type="hidden" name="t" value="${escapeAttr(token)}">
<p>Stop reminder emails for the conversation hour? Nothing else changes; you can turn them back on any time under Profile → Reminders.</p>
<p><button type="submit" style="background:#e2745a;color:#fff;border:0;border-radius:999px;padding:.7rem 1.2rem;font-size:1rem;cursor:pointer">Yes, stop reminder emails</button></p></form>`;
  return page("Stop reminder emails?", form, site, 200);
}

export async function POST(req: Request) {
  const site = env.siteUrl();
  const url = new URL(req.url);
  let token = url.searchParams.get("t") ?? "";
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const fd = await req.formData().catch(() => null);
    const t = fd?.get("t");
    if (typeof t === "string" && t) token = t;
    // RFC 8058 one-click requests carry List-Unsubscribe=One-Click and the token in the URL
  }
  const accountId = verifyUnsubscribeToken(token);
  if (!accountId) return page("That unsubscribe link isn't valid.", "<p>You can manage reminders under Profile → Reminders after signing in.</p>", site, 400);
  const admin = supabaseAdmin();
  await admin.from("reminder_prefs").upsert({ account_id: accountId, email_enabled: false, updated_at: new Date().toISOString() }, { onConflict: "account_id" });
  await admin.from("consent_events").insert({ account_id: accountId, kind: "reminders_email", version: "v1", granted: false });
  return page("Email reminders are off.", "<p>You won't get reminder emails for the conversation hour. You can turn them back on any time under Profile → Reminders.</p>", site, 200);
}

function escapeAttr(s: string) { return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

function page(title: string, body: string, site: string, status: number) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#fbf7f0;color:#2a2520;margin:0;padding:2rem 1rem;display:flex;justify-content:center}main{max-width:28rem;background:#fff;border:1px solid #ebe2d3;border-radius:22px;padding:1.5rem}a{color:#e2745a}</style></head>
<body><main><h1 style="font-size:1.4rem;margin:0 0 .5rem">${title}</h1>${body}<p><a href="${site}/settings#reminders">Open Common Ground</a></p></main></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
