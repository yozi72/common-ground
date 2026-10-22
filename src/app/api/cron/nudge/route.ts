import { NextResponse, after } from "next/server";
import { requireUser, handle } from "@/lib/api";
import { maybeTick } from "@/lib/workers/tick";

// Signed-in clients call this while waiting so housekeeping runs even without
// an external scheduler. Throttled server-side; cheap when nothing is due.
// The opportunistic worker tick runs in after() with its own 25 s budget; the
// function limit is explicit so the hosting default never decides it.
export const maxDuration = 60;

export async function POST() {
  return handle(async () => {
    await requireUser();
    after(() => maybeTick());
    return NextResponse.json({ ok: true });
  });
}
