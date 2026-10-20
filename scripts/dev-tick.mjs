#!/usr/bin/env node
// Development scheduler: calls the worker tick every 15 seconds. In production,
// point Vercel Cron, GitHub Actions, or any scheduler at POST /api/cron/tick
// with `Authorization: Bearer $CRON_SECRET` (see vercel.json).
const base = process.env.SITE_URL ?? "http://localhost:3000";
const secret = process.env.CRON_SECRET ?? "";
const every = Number(process.env.TICK_SECONDS ?? 15) * 1000;

async function tick() {
  try {
    const res = await fetch(`${base}/api/cron/tick`, { method: "POST", headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
    const body = await res.json();
    const m = body.moderation ?? {};
    console.log(new Date().toISOString(), res.status, `pairs=${body.matching?.pairs ?? "?"} moderated=${m.processed ?? "?"} deferred=${m.deferred ?? "?"}`);
  } catch (e) {
    console.log(new Date().toISOString(), "tick failed:", e.message);
  }
}
tick();
setInterval(tick, every);
