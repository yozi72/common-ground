import { NextResponse } from "next/server";
import { getScheduleConfig } from "@/lib/schedule-config";
import { buildIcs, googleCalendarUrl, effectiveDays, parseDaysParam, type CalendarMode } from "@/lib/calendar";
import { env } from "@/lib/env";

// GET /api/calendar?mode=next|weekdays|daily&days=1,2,3[&google=1]
// Public: the schedule itself is not secret, and calendar apps fetch without cookies.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = (["next", "weekdays", "daily"].includes(url.searchParams.get("mode") ?? "") ? url.searchParams.get("mode") : "daily") as CalendarMode;
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) return NextResponse.json({ error: "Invalid day selection" }, { status: 400 });
  const cfg = await getScheduleConfig();
  const site = env.siteUrl();
  if (!effectiveDays(mode, days, cfg)) return NextResponse.json({ error: "Pick at least one session day" }, { status: 400 });
  if (url.searchParams.get("google") === "1") {
    return NextResponse.redirect(googleCalendarUrl({ mode, days, cfg, siteUrl: site }));
  }
  const ics = buildIcs({ mode, days, cfg, siteUrl: site });
  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="common-ground-${mode}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
