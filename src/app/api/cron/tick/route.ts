import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runTick } from "@/lib/workers/tick";
import { secretsEqual } from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // must be a literal for Next; keep equal to TICK_MAX_DURATION_SECONDS in workers/tick.ts

// Scheduler entry point (Vercel Cron, GitHub Actions, a `while true` loop in dev).
// Protected by CRON_SECRET; in development an unset secret is allowed.
export async function POST(req: Request) {
  const secret = env.cronSecret();
  const auth = req.headers.get("authorization");
  const given = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  // constant-time; a missing secret or a missing/short header never matches
  if (env.isProduction() && !secretsEqual(given, secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!env.isProduction() && secret && auth && !secretsEqual(given, secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const result = await runTick({ retention: url.searchParams.get("retention") === "1", source: req.headers.get("user-agent")?.includes("pg_net") ? "pg_cron" : "http" });
  return NextResponse.json({ ok: true, at: new Date().toISOString(), ...result });
}

export const GET = POST;
