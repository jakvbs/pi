import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BoardLane, BoardSubagent, BoardTicket } from "./factory-board-types";
import type { SessionInfo } from "./types";

// The factory board's lanes, read from a spec directory laid out as
// ~/.repos/legible/spec/README.md says: features/{active,planned}/FNNN-slug/
// and features/done/YYYY-MM/FNNN-slug/, each holding ticket.md. Read-only.

/** Done tickets the board shows, as `bun run work board` writes PROVEN. */
export const BOARD_DONE_SHOWN = 10;

/** PI_WEB_SPEC_DIR, else the factory's spec in ~/.repos/legible. */
export function boardSpecDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_WEB_SPEC_DIR || join(homedir(), ".repos", "legible", "spec");
}

function subdirectories(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readTicket(lane: BoardLane, lanePath: string, folder: string): BoardTicket {
  const id = /^(F\d+)-/.exec(folder)?.[1] ?? folder;
  let text = "";
  try {
    text = readFileSync(join(lanePath, folder, "ticket.md"), "utf8");
  } catch {
    // A folder without a readable ticket still shows, under its own name.
  }
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim();
  const heading = /^# (.+)$/m.exec(text)?.[1]?.trim();
  const title = heading?.replace(/^F\d+\s*·\s*/, "") || folder;
  const repo = field("repo");
  const landed = field("landed");
  return { id, folder, lane, title, ...(repo ? { repo } : {}), ...(landed ? { landed } : {}) };
}

function featureNumber(ticket: BoardTicket): number {
  return Number(/^F(\d+)$/.exec(ticket.id)?.[1] ?? -1);
}

/** Every folder of the active and planned lanes, and the latest done ones by landing date. */
export function readBoardLanes(specDir: string): Record<BoardLane, BoardTicket[]> {
  const features = join(specDir, "features");
  const lane = (name: "active" | "planned") => {
    const path = join(features, name);
    return subdirectories(path).map((folder) => readTicket(name, path, folder));
  };
  const donePath = join(features, "done");
  const done = subdirectories(donePath)
    .flatMap((month) => subdirectories(join(donePath, month)).map((folder) => {
      const ticket = readTicket("done", join(donePath, month), folder);
      return ticket.landed ? ticket : { ...ticket, landed: month };
    }))
    .sort((left, right) => (right.landed ?? "").localeCompare(left.landed ?? "") || featureNumber(right) - featureNumber(left))
    .slice(0, BOARD_DONE_SHOWN);
  return { active: lane("active"), planned: lane("planned"), done };
}

/** Subagents without a ticket the board lists, newest first. */
const UNTICKETED_SHOWN = 20;

/**
 * The board's subagents: every ticketed child, then the latest unticketed ones.
 * The model comes from the child's start record; only a child started before
 * the record named it costs a read of its session (`olderChildModel`).
 */
export function boardSubagents(
  sessions: readonly SessionInfo[],
  olderChildModel: (session: SessionInfo) => string | undefined,
): BoardSubagent[] {
  const children = sessions.flatMap((session) => session.relation?.kind === "subagent" ? [{ session, relation: session.relation }] : []);
  const ticketed = children.filter(({ relation }) => relation.ticket);
  const unticketed = children
    .filter(({ relation }) => !relation.ticket)
    .sort((left, right) => right.session.created.localeCompare(left.session.created))
    .slice(0, UNTICKETED_SHOWN);
  return [...ticketed, ...unticketed].map(({ session, relation }) => {
    const model = relation.model ?? olderChildModel(session);
    return {
      sessionId: session.id,
      ...(relation.ticket ? { ticket: relation.ticket } : {}),
      ...(relation.repo ? { repo: relation.repo } : {}),
      status: relation.status,
      profile: relation.profile,
      description: relation.description,
      ...(model ? { model } : {}),
      created: session.created,
    };
  });
}
