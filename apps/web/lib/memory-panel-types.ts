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

export interface MemorySnapshot {
  sessionId: string;
  /** True when a running wrapper holds the session; status and errors exist only then. */
  live: boolean;
  /** The footer status `compact N% · K×` the extension last set, without colors. */
  status?: string;
  /** `/om:status`'s Memory lines, computed the same way from the same branch. */
  observationLine: string;
  reflectionLine: string;
  observer?: MemoryRun;
  reflector?: MemoryRun;
  /** The session's latest observational-memory warnings (stage and consolidation failures). */
  errors: Array<{ at: string; message: string }>;
  /** Visible memory, as `/om:view` prints it. */
  memoryText: string;
  /** Everything the branch recorded, as `/om:view full` prints it. */
  recordedMemoryText: string;
  /** The fork module the counts come from. */
  ledgerModule: string;
}
