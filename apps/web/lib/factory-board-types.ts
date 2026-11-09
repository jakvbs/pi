import type { SubagentSessionStatus } from "./types";

// Client-safe shapes of GET /api/board: the factory's spec lanes and the
// subagents working on its tickets (F046 prototype).

export type BoardLane = "active" | "planned" | "done";

export interface BoardTicket {
  /** Feature id from the folder name (`F046`), or the folder name when it has none. */
  id: string;
  folder: string;
  lane: BoardLane;
  /** The ticket's `# FNNN · title` text after the id; the folder name when unreadable. */
  title: string;
  repo?: string;
  /** `landed:` of a done ticket (YYYY-MM-DD). */
  landed?: string;
}

export interface BoardSubagent {
  sessionId: string;
  ticket?: string;
  /** Repository the child works in when it is not its parent's (`Agent`'s `repo`). */
  repo?: string;
  status: SubagentSessionStatus;
  profile: string;
  description: string;
  /** `provider/id` the child started on (its start record, or its branch for an older child). */
  model?: string;
  created: string;
}

export interface FactoryBoard {
  specDir: string;
  lanes: Record<BoardLane, BoardTicket[]>;
  /** Subagents with a ticket, then the latest ones without. */
  subagents: BoardSubagent[];
  /** Why the lanes could not be read (missing spec directory); the subagents still show. */
  error?: string;
}
