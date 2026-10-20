import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runTick } from "@/lib/workers/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Scheduler entry point (Vercel Cron, GitHub Actions, a `while true` loop in dev).
// Protected by CRON_SECRET; in development an unset secret is allowed.
export async function POST(req: Request) {
  const secret = env.cronSecret();
  const auth = req.headers.get("authorization");
  if (env.isProduction() && (!secret || auth !== `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!env.isProduction() && secret && auth && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const result = await runTick({ retention: url.searchParams.get("retention") === "1" });
  return NextResponse.json({ ok: true, at: new Date().toISOString(), ...result });
}

export const GET = POST;
