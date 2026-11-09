import { NextResponse } from "next/server";
import { boardSpecDir, readBoardLanes } from "@/lib/factory-board";
import type { BoardSubagent, FactoryBoard } from "@/lib/factory-board-types";
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

/** Subagents without a ticket the board lists, newest first. */
const UNTICKETED_SHOWN = 20;

function childModel(session: SessionInfo): string | undefined {
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
  const children = withSubagentDisplayStatus(mergeSessionLists(persisted, live))
    .filter((session) => session.relation?.kind === "subagent");
  const ticketed = children.filter((session) => session.relation?.kind === "subagent" && session.relation.ticket);
  const unticketed = children
    .filter((session) => session.relation?.kind === "subagent" && !session.relation.ticket)
    .sort((left, right) => right.created.localeCompare(left.created))
    .slice(0, UNTICKETED_SHOWN);
  const subagents: BoardSubagent[] = [...ticketed, ...unticketed].flatMap((session) => {
    const relation = session.relation;
    if (relation?.kind !== "subagent") return [];
    const model = childModel(session);
    return [{
      sessionId: session.id,
      ...(relation.ticket ? { ticket: relation.ticket } : {}),
      status: relation.status,
      profile: relation.profile,
      description: relation.description,
      ...(model ? { model } : {}),
      created: session.created,
    }];
  });

  const board: FactoryBoard = { specDir, lanes, subagents, ...(error ? { error } : {}) };
  return NextResponse.json(board, { headers: { "Cache-Control": "no-store" } });
}
