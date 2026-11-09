import { NextResponse } from "next/server";
import { boardSpecDir, boardSubagents, readBoardLanes } from "@/lib/factory-board";
import type { FactoryBoard } from "@/lib/factory-board-types";
import { getRpcSession, getRpcSessionInfos, withSubagentDisplayStatus } from "@/lib/rpc-manager";
import {
  attachSessionProjectInfo,
  getSessionSettings,
  listAllSessions,
  mergeSessionLists,
  openSessionManager,
} from "@/lib/session-reader";
import type { SessionEntry, SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A child started before its start record named its model: read the model from its session. */
function olderChildModel(session: SessionInfo): string | undefined {
  try {
    const live = getRpcSession(session.id);
    const manager = live?.isAlive() ? live.inner.sessionManager : session.path ? openSessionManager(session.path) : undefined;
    if (!manager) return undefined;
    const { model } = getSessionSettings(manager.getEntries() as unknown as SessionEntry[], manager.getLeafId());
    return model ? `${model.provider}/${model.modelId}` : undefined;
  } catch {
    return undefined;
  }
}

// GET /api/board - The factory board (F046 prototype): the spec lanes from
// PI_WEB_SPEC_DIR (default ~/.repos/legible/spec) and the subagents under each
// ticket, with the session list's live status. Reads only; never starts a wrapper.
export async function GET() {
  const specDir = boardSpecDir();
  let lanes: FactoryBoard["lanes"] = { active: [], planned: [], done: [] };
  let error: string | undefined;
  try {
    lanes = readBoardLanes(specDir);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const [persisted, live] = await Promise.all([listAllSessions(), attachSessionProjectInfo(getRpcSessionInfos())]);
  const subagents = boardSubagents(withSubagentDisplayStatus(mergeSessionLists(persisted, live)), olderChildModel);

  const board: FactoryBoard = { specDir, lanes, subagents, ...(error ? { error } : {}) };
  return NextResponse.json(board, { headers: { "Cache-Control": "no-store" } });
}
