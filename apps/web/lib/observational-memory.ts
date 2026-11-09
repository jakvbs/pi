import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripAnsi } from "./ansi";
import type { MemoryRun, MemorySnapshot } from "./memory-panel-types";

// The memory panel's reading of one session branch (F046 prototype). Counts
// come from the pi fork's own session ledger, imported from its source rather
// than copied, so the panel and `/om:status` cannot disagree on what the
// branch remembers. Node strips the module's types; Turbopack never sees it.

interface LedgerEntry {
  type: string;
  id: string;
  timestamp?: string;
}

interface Observation { id: string; content: string; timestamp: string; relevance: string }
interface Reflection { id: string; content: string }
interface Projection { observations: Observation[]; reflections: Reflection[] }

/** The part of the fork's `extensions/observational-memory/src/session-ledger/index.ts` the panel reads. */
interface SessionLedgerModule {
  foldLedger(entries: LedgerEntry[]): {
    observations: Observation[];
    activeObservations: Observation[];
    droppedObservationIds: Set<string>;
    reflections: Reflection[];
  };
  visibleProjection(entries: LedgerEntry[]): Projection;
  fullProjection(entries: LedgerEntry[]): Projection;
  diffProjection(visible: Projection, full: Projection): {
    observationsOnlyInFull: Observation[];
    reflectionsOnlyInFull: Reflection[];
    droppedOnlyInFull: Observation[];
  };
  branchLedger(entries: LedgerEntry[]): Array<{
    entry: LedgerEntry & { customType: string; data: { coversUpToId?: string; observations?: unknown[]; reflections?: unknown[]; observationIds?: unknown[] } };
  }>;
  observationToSummaryLine(observation: Observation): string;
  reflectionToSummaryLine(reflection: Reflection): string;
}

/** The extension's footer status key (`ACTIVATION_STATUS_KEY`). */
const ACTIVATION_STATUS_KEY = "observational-memory";
const NOTICE_PREFIX = "Observational memory:";

export function sessionLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const repo = env.PI_MONO_REPO || join(homedir(), ".repos", "pi");
  return join(repo, "extensions", "observational-memory", "src", "session-ledger", "index.ts");
}

let ledgerModule: Promise<SessionLedgerModule> | undefined;

function loadSessionLedger(): Promise<SessionLedgerModule> {
  ledgerModule ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(sessionLedgerPath()).href)
    .then((loaded: SessionLedgerModule) => {
      if (typeof loaded.foldLedger !== "function" || typeof loaded.visibleProjection !== "function") {
        throw new Error(`${sessionLedgerPath()} does not export the session ledger`);
      }
      return loaded;
    })
    .catch((error: unknown) => {
      ledgerModule = undefined;
      throw error;
    });
  return ledgerModule;
}

function suffixed(line: string, suffixes: Array<[string, number]>): string {
  const shown = suffixes.filter(([, count]) => count > 0).map(([sign, count]) => `${sign}${count.toLocaleString()}`);
  return shown.length > 0 ? `${line} ${shown.join(" ")}` : line;
}

function latestRun(
  ledger: ReturnType<SessionLedgerModule["branchLedger"]>,
  customTypes: readonly string[],
): MemoryRun | undefined {
  const last = ledger.filter(({ entry }) => customTypes.includes(entry.customType)).at(-1);
  if (!last) return undefined;
  // A reflector pass appends its reflections and drops under one marker; count both.
  const pass = ledger.filter(({ entry }) => customTypes.includes(entry.customType) && entry.data.coversUpToId === last.entry.data.coversUpToId);
  const recorded = pass.reduce((sum, { entry }) => sum + (entry.data.observations?.length ?? entry.data.reflections?.length ?? 0), 0);
  const dropped = pass.reduce((sum, { entry }) => sum + (entry.data.observationIds?.length ?? 0), 0);
  return { at: last.entry.timestamp ?? "", recorded, ...(dropped > 0 ? { dropped } : {}) };
}

export interface MemorySource {
  sessionId: string;
  entries: LedgerEntry[];
  /** The running wrapper, when there is one: the status and notices live only there. */
  live?: {
    getExtensionStatus(key: string): string | undefined;
    getRecentNotices(): ReadonlyArray<{ at: string; message: string }>;
  };
}

/** What `/om:status` and `/om:view` show for this branch, plus the latest stage runs and errors. */
export async function buildMemorySnapshot(source: MemorySource): Promise<MemorySnapshot> {
  const ledger = await loadSessionLedger();
  const { entries } = source;
  const folded = ledger.foldLedger(entries);
  const visible = ledger.visibleProjection(entries);
  const full = ledger.fullProjection(entries);
  const drift = ledger.diffProjection(visible, full);
  const branch = ledger.branchLedger(entries);
  const status = source.live?.getExtensionStatus(ACTIVATION_STATUS_KEY);
  const observer = latestRun(branch, ["om.observations.recorded"]);
  const reflector = latestRun(branch, ["om.reflections.recorded", "om.observations.dropped"]);
  const render = (projection: Projection, scope: string) => [
    "── Reflections ──",
    projection.reflections.map(ledger.reflectionToSummaryLine).join("\n") || `No ${scope} reflections.`,
    "",
    "── Observations ──",
    projection.observations.map(ledger.observationToSummaryLine).join("\n") || `No ${scope} observations.`,
  ].join("\n");
  return {
    sessionId: source.sessionId,
    live: source.live !== undefined,
    ...(status ? { status: stripAnsi(status) } : {}),
    observationLine: suffixed(
      `Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${folded.activeObservations.length} active / ${visible.observations.length} visible`,
      [["+", drift.observationsOnlyInFull.length], ["-", drift.droppedOnlyInFull.length]],
    ),
    reflectionLine: suffixed(
      `Reflections:  ${folded.reflections.length} recorded / ${visible.reflections.length} visible`,
      [["+", drift.reflectionsOnlyInFull.length]],
    ),
    ...(observer ? { observer } : {}),
    ...(reflector ? { reflector } : {}),
    errors: (source.live?.getRecentNotices() ?? [])
      .filter((notice) => notice.message.startsWith(NOTICE_PREFIX))
      .map(({ at, message }) => ({ at, message: message.slice(NOTICE_PREFIX.length).trim() })),
    memoryText: render(visible, "visible"),
    recordedMemoryText: render(full, "recorded"),
    ledgerModule: sessionLedgerPath(),
  };
}
