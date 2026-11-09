import { getPackageDir, type EventBus } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripAnsi } from "./ansi";
import type { MemoryRun, MemorySnapshot, MemoryStatus } from "./memory-panel-types";

// The memory panel's reading of one session (F046 prototype). A running
// session's status, progress and stage errors are what observational memory
// publishes on its event bus, the same values `/om:status` prints. The counts
// of a session read from its file, the latest runs and the memory text come
// from the pi fork's own modules, imported from source rather than copied, so
// the panel and `/om:status` cannot disagree. Node strips the modules' types;
// Turbopack never sees them.

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
  visibleProjection(entries: LedgerEntry[]): Projection;
  fullProjection(entries: LedgerEntry[]): Projection;
  branchLedger(entries: LedgerEntry[]): Array<{
    entry: LedgerEntry & { customType: string; data: { coversUpToId?: string; observations?: unknown[]; reflections?: unknown[]; observationIds?: unknown[] } };
  }>;
  observationToSummaryLine(observation: Observation): string;
  reflectionToSummaryLine(reflection: Reflection): string;
}

/** The part of the fork's `extensions/observational-memory/src/memory-status.ts` the panel reads. */
interface MemoryStatusModule {
  memoryCountLines(entries: LedgerEntry[]): string[];
}

/** The extension's footer status key (`ACTIVATION_STATUS_KEY`). */
const ACTIVATION_STATUS_KEY = "observational-memory";

/** The channel the extension publishes its status on (`MEMORY_STATUS_EVENT`). */
export const MEMORY_STATUS_EVENT = "observational-memory:status";

function extensionSourceDir(env: NodeJS.ProcessEnv): string {
  // The fork whose packages/coding-agent pi-web runs, so the modules import that same SDK.
  const repo = env.PI_MONO_REPO || join(getPackageDir(), "..", "..");
  return join(repo, "extensions", "observational-memory", "src");
}

export function sessionLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(extensionSourceDir(env), "session-ledger", "index.ts");
}

export function memoryStatusPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(extensionSourceDir(env), "memory-status.ts");
}

interface ForkModules { ledger: SessionLedgerModule; status: MemoryStatusModule }

let forkModules: Promise<ForkModules> | undefined;

function importForkModule<T>(path: string): Promise<T> {
  return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(path).href);
}

function loadForkModules(): Promise<ForkModules> {
  forkModules ??= Promise.all([
    importForkModule<SessionLedgerModule>(sessionLedgerPath()),
    importForkModule<MemoryStatusModule>(memoryStatusPath()),
  ])
    .then(([ledger, status]) => {
      // The fork's source is outside pi-web's type check: an older checkout lacks these exports.
      if (typeof ledger.branchLedger !== "function" || typeof ledger.visibleProjection !== "function") {
        throw new Error(`${sessionLedgerPath()} does not export the session ledger`);
      }
      if (typeof status.memoryCountLines !== "function") {
        throw new Error(`${memoryStatusPath()} does not export memoryCountLines`);
      }
      return { ledger, status };
    })
    .catch((error: unknown) => {
      forkModules = undefined;
      throw error;
    });
  return forkModules;
}

/** The latest status a session's observational memory published on `bus`. */
export interface MemoryStatusWatch {
  latest(): MemoryStatus | undefined;
}

/** Keep the latest `MEMORY_STATUS_EVENT` a session's extensions publish; subscribe before they load. */
export function watchMemoryStatus(bus: EventBus): MemoryStatusWatch {
  let latest: MemoryStatus | undefined;
  bus.on(MEMORY_STATUS_EVENT, (data) => {
    latest = parseMemoryStatus(data) ?? latest;
  });
  return { latest: () => latest };
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const optionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";

/** The event bus carries `unknown`: an extension of another version may publish another shape. */
function parseMemoryStatus(data: unknown): MemoryStatus | undefined {
  if (!isRecord(data) || typeof data.passive !== "boolean") return undefined;
  const { memory, activity, inFlight, errors } = data;
  if (!isStrings(memory) || !isStrings(activity) || !isStrings(inFlight) || !isRecord(errors)) return undefined;
  const { observer, reflector } = errors;
  if (!optionalString(observer) || !optionalString(reflector)) return undefined;
  return {
    passive: data.passive,
    memory,
    activity,
    inFlight,
    errors: { ...(observer ? { observer } : {}), ...(reflector ? { reflector } : {}) },
  };
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
  /** The running wrapper, when there is one: the status lives only there. */
  live?: {
    getExtensionStatus(key: string): string | undefined;
    getMemoryStatus(): MemoryStatus | undefined;
  };
}

/** What `/om:status` and `/om:view` show for this branch, plus the latest stage runs. */
export async function buildMemorySnapshot(source: MemorySource): Promise<MemorySnapshot> {
  const { ledger, status: statusModule } = await loadForkModules();
  const { entries } = source;
  const visible = ledger.visibleProjection(entries);
  const full = ledger.fullProjection(entries);
  const branch = ledger.branchLedger(entries);
  const footer = source.live?.getExtensionStatus(ACTIVATION_STATUS_KEY);
  const omStatus = source.live?.getMemoryStatus();
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
    ...(footer ? { status: stripAnsi(footer) } : {}),
    ...(omStatus ? { omStatus } : {}),
    memoryLines: omStatus?.memory ?? statusModule.memoryCountLines(entries),
    ...(observer ? { observer } : {}),
    ...(reflector ? { reflector } : {}),
    memoryText: render(visible, "visible"),
    recordedMemoryText: render(full, "recorded"),
    ledgerModule: sessionLedgerPath(),
  };
}
