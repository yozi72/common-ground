import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runTick } from "@/lib/workers/tick";
import { secretsEqual } from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";

// A configured secret is required in EVERY environment (missing or wrong header → 401).
// Only when no secret is configured does development allow unauthenticated ticks;
// production never does.
export function authorizeCron(authHeader: string | null, secret: string | null, isProduction: boolean): boolean {
  const given = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (secret) return secretsEqual(given, secret);
  return !isProduction;
}
export const maxDuration = 60; // must be a literal for Next; keep equal to TICK_MAX_DURATION_SECONDS in workers/tick.ts

// Scheduler entry point (Vercel Cron, GitHub Actions, a `while true` loop in dev).
// Protected by CRON_SECRET; in development an unset secret is allowed.
export async function POST(req: Request) {
  if (!authorizeCron(req.headers.get("authorization"), env.cronSecret(), env.isProduction())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const result = await runTick({ retention: url.searchParams.get("retention") === "1", source: req.headers.get("user-agent")?.includes("pg_net") ? "pg_cron" : "http" });
  return NextResponse.json({ ok: true, at: new Date().toISOString(), ...result });
}

export const GET = POST;
