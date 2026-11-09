import { NextResponse } from "next/server";
import { buildMemorySnapshot } from "@/lib/observational-memory";
import { getRpcSession } from "@/lib/rpc-manager";
import { openSessionManager, resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/sessions/[id]/memory - The memory panel (F046 prototype): what
// observational memory holds on the session's current branch, read through the
// pi fork's session ledger, plus the running wrapper's status and warnings.
// Reads only; never starts a wrapper.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const live = getRpcSession(id);
  let manager;
  if (live?.isAlive()) {
    manager = live.inner.sessionManager;
  } else {
    const path = await resolveSessionPath(id);
    if (!path) return NextResponse.json({ error: "Session not found" }, { status: 404, headers: NO_STORE });
    manager = openSessionManager(path);
  }
  try {
    const snapshot = await buildMemorySnapshot({
      sessionId: id,
      entries: manager.getBranch(),
      ...(live?.isAlive() ? { live } : {}),
    });
    return NextResponse.json(snapshot, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500, headers: NO_STORE });
  }
}
