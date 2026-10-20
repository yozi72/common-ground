import { NextResponse, after } from "next/server";
import { requireUser, handle } from "@/lib/api";
import { maybeTick } from "@/lib/workers/tick";

// Signed-in clients call this while waiting so housekeeping runs even without
// an external scheduler. Throttled server-side; cheap when nothing is due.
export async function POST() {
  return handle(async () => {
    await requireUser();
    after(() => maybeTick());
    return NextResponse.json({ ok: true });
  });
}
