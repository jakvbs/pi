// Memory status as data: what `/om:status` prints, also published on `pi.events` for other views.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { observationPoolMetrics } from "./agents/reflector/pool.ts";
import { resolveCompactAfterTokens } from "./config.ts";
import { debugLog } from "./debug-log.ts";
import type { Runtime } from "./runtime.ts";
import {
	diffProjection,
	foldLedger,
	fullProjection,
	measuredObservedTokensSinceLastCompaction,
	measuredTokensSinceLastCompaction,
	rawObservedTokensSinceReflectorPass,
	rawTokensSinceObservationCoverage,
	visibleProjection,
	type Entry,
} from "./session-ledger/index.ts";

/** The `pi.events` channel that carries a `MemoryStatus` whenever memory may have changed. */
export const MEMORY_STATUS_EVENT = "observational-memory:status";

/** The sections `/om:status` prints, as lines, with the stage errors as raw text. */
export interface MemoryStatus {
	passive: boolean;
	/** `── Memory ──`: recorded, dropped, active and visible counts. */
	memory: string[];
	/** `── Activity ──`: progress toward the next observation, reflection and activation, the backlog and the pools. */
	activity: string[];
	/** `── In flight ──`: a running consolidation (with its phase) or compaction hook. */
	inFlight: string[];
	/** `── Last error ──`: the latest observer and reflector failures, cleared when the next pass starts. */
	errors: { observer?: string; reflector?: string };
}

/** The part of an extension context the status reads. */
type MemoryStatusCtx = Pick<ExtensionContext, "sessionManager" | "model" | "getContextUsage">;

/** The memory status of the context's current branch. */
export function memoryStatus(runtime: Runtime, ctx: MemoryStatusCtx): MemoryStatus {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const view = ledgerView(entries);
	const { config } = runtime;
	const activeObservationPool = observationPoolMetrics(view.folded.activeObservations, config.observationsPoolTargetTokens);
	const obsProgress = rawTokensSinceObservationCoverage(entries);
	const reflectionProgress = rawObservedTokensSinceReflectorPass(entries);
	const unobservedSinceCompaction = Math.max(
		0,
		measuredTokensSinceLastCompaction(entries) - measuredObservedTokensSinceLastCompaction(entries),
	);
	const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
	const activationThreshold = resolveCompactAfterTokens(config, contextWindow);
	const contextTokens = ctx.getContextUsage()?.tokens;
	const inFlight: string[] = [];
	if (runtime.consolidationInFlight) {
		inFlight.push(`Consolidation: running${runtime.consolidationPhase ? ` (${runtime.consolidationPhase})` : ""}`);
	}
	if (runtime.compactHookInFlight) inFlight.push("Compaction hook: running");
	return {
		passive: config.passive === true,
		memory: countLines(view),
		activity: [
			`Next observation: ~${obsProgress.toLocaleString()} / ${config.observeAfterTokens.toLocaleString()} tokens (${pct(obsProgress, config.observeAfterTokens)}%)`,
			`Next reflection:  ~${reflectionProgress.toLocaleString()} / ${config.reflectAfterTokens.toLocaleString()} observed source tokens (${pct(reflectionProgress, config.reflectAfterTokens)}%)`,
			contextTokens == null
				? `Next activation:  context size unknown until the next response / ${activationThreshold.toLocaleString()} context tokens`
				: `Next activation:  ~${contextTokens.toLocaleString()} / ${activationThreshold.toLocaleString()} context tokens (${pct(contextTokens, activationThreshold)}%)`,
			`Observer backlog: ~${unobservedSinceCompaction.toLocaleString()} unobserved source tokens since the compaction boundary`,
			`Active observation pool: ~${activeObservationPool.observationTokens.toLocaleString()} tokens (reflection at ${config.observationsPoolMaxTokens.toLocaleString()}, drops above ${config.observationsPoolTargetTokens.toLocaleString()})`,
			`Visible observation pool: ~${tokenSum(view.visible.observations).toLocaleString()} tokens`,
			`Visible reflection pool:  ~${tokenSum(view.visible.reflections).toLocaleString()} tokens`,
		],
		inFlight,
		errors: {
			...(runtime.lastObserverError ? { observer: runtime.lastObserverError } : {}),
			...(runtime.lastReflectorError ? { reflector: runtime.lastReflectorError } : {}),
		},
	};
}

/** `/om:status`'s Memory lines for a branch, for a view that has the entries but no running extension. */
export function memoryCountLines(entries: Entry[]): string[] {
	return countLines(ledgerView(entries));
}

/** The text `/om:status` prints for a status. */
export function renderMemoryStatus(status: MemoryStatus): string {
	const lines = [
		...(status.passive
			? [
				"── Mode ──",
				"Passive: automatic memory workers and activation disabled; manual/Pi compaction, commands, and recall remain active",
				"",
			]
			: []),
		"── Memory ──",
		...status.memory,
		"",
		"── Activity ──",
		...status.activity,
	];
	if (status.inFlight.length > 0) lines.push("", "── In flight ──", ...status.inFlight);
	if (status.errors.observer || status.errors.reflector) {
		lines.push("", "── Last error ──");
		if (status.errors.observer) lines.push(`Observer: ${status.errors.observer}`);
		if (status.errors.reflector) lines.push(`Reflector: ${status.errors.reflector}`);
	}
	return lines.join("\n");
}

type LedgerView = ReturnType<typeof ledgerView>;

function ledgerView(entries: Entry[]) {
	const folded = foldLedger(entries);
	const visible = visibleProjection(entries);
	const drift = diffProjection(visible, fullProjection(entries));
	return { folded, visible, drift };
}

function countLines({ folded, visible, drift }: LedgerView): string[] {
	return [
		appendSuffixes(
			`Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${folded.activeObservations.length} active / ${visible.observations.length} visible`,
			[addedSuffix(drift.observationsOnlyInFull.length), removedSuffix(drift.droppedOnlyInFull.length)],
		),
		appendSuffixes(
			`Reflections:  ${folded.reflections.length} recorded / ${visible.reflections.length} visible`,
			[addedSuffix(drift.reflectionsOnlyInFull.length)],
		),
	];
}

function addedSuffix(count: number): string | undefined {
	return count > 0 ? `+${count.toLocaleString()}` : undefined;
}

function removedSuffix(count: number): string | undefined {
	return count > 0 ? `-${count.toLocaleString()}` : undefined;
}

function appendSuffixes(line: string, suffixes: (string | undefined)[]): string {
	const rendered = suffixes.filter((suffix): suffix is string => suffix !== undefined);
	return rendered.length > 0 ? `${line} ${rendered.join(" ")}` : line;
}

function pct(current: number, total: number): number {
	return total > 0 ? Math.round((current / total) * 100) : 0;
}

function tokenSum(items: { tokenCount: number }[]): number {
	return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

/**
 * Publish the status on `MEMORY_STATUS_EVENT` at every event that can change it,
 * and once more when a consolidation pass launched there ends (its stage errors).
 * Register after the consolidation trigger, so a pass launched at the same event is seen.
 */
export function registerMemoryStatusEvents(pi: ExtensionAPI, runtime: Runtime): void {
	let watchedPass: Promise<void> | null = null;
	const publish = (ctx: ExtensionContext) => {
		runtime.ensureConfig(ctx.cwd);
		pi.events.emit(MEMORY_STATUS_EVENT, memoryStatus(runtime, ctx));
		const pass = runtime.consolidationPromise;
		if (!pass || pass === watchedPass) return;
		watchedPass = pass;
		void pass.then(() => {
			try {
				pi.events.emit(MEMORY_STATUS_EVENT, memoryStatus(runtime, ctx));
			} catch (error) {
				// The session was replaced while the pass ran: `ctx` and `pi` are stale and nobody listens.
				debugLog("status.publish_skipped", { errorMessage: error instanceof Error ? error.message : String(error) });
			}
		});
	};
	pi.on("session_start", (_event, ctx) => publish(ctx));
	pi.on("model_select", (_event, ctx) => publish(ctx));
	pi.on("session_tree", (_event, ctx) => publish(ctx));
	pi.on("session_compact", (_event, ctx) => publish(ctx));
	pi.on("agent_start", (_event, ctx) => publish(ctx));
	pi.on("agent_settled", (_event, ctx) => publish(ctx));
	pi.on("turn_end", (_event, ctx) => {
		publish(ctx);
		return undefined;
	});
}
