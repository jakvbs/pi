// Client-safe shape of GET /api/sessions/[id]/memory: what observational
// memory holds and does in one session (F046 prototype).

export interface MemoryRun {
  /** Timestamp of the ledger entry the run appended. */
  at: string;
  /** Observations or reflections it recorded. */
  recorded: number;
  /** Observations a reflector pass dropped. */
  dropped?: number;
}

/**
 * What `/om:status` prints, as the running extension publishes it on
 * `pi.events` (`MemoryStatus` in the fork's `extensions/observational-memory/src/memory-status.ts`).
 */
export interface MemoryStatus {
  passive: boolean;
  /** Recorded, dropped, active and visible counts. */
  memory: string[];
  /** Progress toward the next observation, reflection and activation, the backlog and the pools. */
  activity: string[];
  /** A running consolidation (with its phase) or compaction hook. */
  inFlight: string[];
  /** The latest observer and reflector failures, cleared when the next pass starts. */
  errors: { observer?: string; reflector?: string };
}

export interface MemorySnapshot {
  sessionId: string;
  /** True when a running wrapper holds the session; status and errors exist only then. */
  live: boolean;
  /** The footer status `compact N% · K×` the extension last set, without colors. */
  status?: string;
  /** The latest status the running extension published; absent from a file or before its first event. */
  omStatus?: MemoryStatus;
  /** `/om:status`'s Memory lines: the published ones, or the extension's own function run on the file's branch. */
  memoryLines: string[];
  observer?: MemoryRun;
  reflector?: MemoryRun;
  /** Visible memory, as `/om:view` prints it. */
  memoryText: string;
  /** Everything the branch recorded, as `/om:view full` prints it. */
  recordedMemoryText: string;
  /** The fork module the counts come from. */
  ledgerModule: string;
}
