import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ObserverStreamError, runObserver } from "../agents/observer/agent.ts";
import { runReflector } from "../agents/reflector/agent.ts";
import { observationPoolMetrics, observationTokenSum } from "../agents/reflector/pool.ts";
import { debugLog, withDebugLogContext } from "../debug-log.ts";
import { resolveObserverChunkMaxTokens, resolveWorkerMemoryMaxTokens } from "../config.ts";
import { recordMemoryEntry } from "../memory-journal.ts";
import type { ConsolidationPhase, Runtime } from "../runtime.ts";
import {
	type ModelResolver,
	makeModelResolver,
	observerChunkContextWindow,
	type ResolvedModel,
	type WorkerModelCtx,
	workerThinkingLevel,
} from "../worker-models.ts";
import { serializeSourceAddressedBranchEntries } from "../serialize.ts";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	boundWorkerMemory,
	buildReflectionsRecordedData,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	latestReflectorPassIndex,
	latestReflectorPassMarkerId,
	observationToSummaryLine,
	realTokensSinceAnchor,
	rawObservedTokensSinceReflectorPass,
	rawTokensSinceObservationCoverage,
	reflectionToSummaryLine,
	type Entry,
	type Observation,
} from "../session-ledger/index.ts";

type ConsolidationCtx = WorkerModelCtx & {
	cwd: string;
	getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined;
	sessionManager: {
		getBranch: () => unknown;
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

type StageOutcome = "continue" | "abort";

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

/**
 * Real current context tokens from the session (provider-reported usage, the
 * same basis the footer percentage uses). Falls back to undefined when the
 * host pi lacks getContextUsage or the count is unknown (e.g. right after a
 * compaction, before the next valid assistant response).
 */
function realContextTokens(ctx: ConsolidationCtx): number | undefined {
	const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
	const tokens = usage?.tokens;
	return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined;
}

/**
 * A stage's progress: the larger of its raw estimate and the provider-reported
 * context growth since its coverage marker at `anchorIndex`. The raw estimate
 * counts source entries a compaction has already removed from context. When
 * coverage lags behind the latest compaction, the provider delta only measures
 * growth since that compaction and would starve the stage forever (a small
 * window that Pi compacts every few thousand tokens never accumulates a
 * threshold's worth of growth), so the raw estimate always counts. When the
 * delta is unmeasurable (no usage baseline, a changed accounting basis, or an
 * old pi host without getContextUsage) the raw estimate decides alone.
 */
function stageTokens(entries: Entry[], raw: number, anchorIndex: number, currentTokens: number | undefined): number {
	const real = currentTokens !== undefined ? realTokensSinceAnchor(entries, anchorIndex, currentTokens) : undefined;
	return real !== undefined ? Math.max(raw, real) : raw;
}

function observerTokens(entries: Entry[], currentTokens: number | undefined): number {
	return stageTokens(entries, rawTokensSinceObservationCoverage(entries), latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED), currentTokens);
}

function reflectorTokens(entries: Entry[], currentTokens: number | undefined): number {
	return stageTokens(entries, rawObservedTokensSinceReflectorPass(entries), latestReflectorPassIndex(entries), currentTokens);
}

/**
 * The reflector is due when the observer recorded observations no reflector
 * pass has read, and either `reflectAfterTokens` of observed source arrived
 * since the last pass or the active observation pool reached
 * `observationsPoolMaxTokens`. After a pass that changed nothing it waits for
 * another `reflectAfterTokens` in that session.
 */
function reflectorDue(
	entries: Entry[],
	runtime: Runtime,
	currentTokens: number | undefined,
	sessionIdentity: string | undefined,
): boolean {
	if (latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED) <= latestReflectorPassIndex(entries)) return false;
	const tokens = reflectorTokens(entries, currentTokens);
	const backoff = runtime.reflectorEmptyBackoff;
	if (
		backoff
		&& backoff.sessionIdentity === sessionIdentity
		&& backoff.passMarkerId === latestReflectorPassMarkerId(entries)
		&& tokens < backoff.tokensAtEmpty + runtime.config.reflectAfterTokens
	) return false;
	return tokens >= runtime.config.reflectAfterTokens
		|| observationTokenSum(foldLedger(entries).activeObservations) >= runtime.config.observationsPoolMaxTokens;
}

function anyStageDue(entries: Entry[], runtime: Runtime, ctx: ConsolidationCtx): boolean {
	const currentTokens = realContextTokens(ctx);
	return observerTokens(entries, currentTokens) >= runtime.config.observeAfterTokens
		|| reflectorDue(entries, runtime, currentTokens, sessionIdentity(ctx));
}

function shouldNotifyWorker(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return runtime.config.showWorkerNotifications && ctx.hasUI;
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const idleMode = (ctx: ConsolidationCtx): boolean => {
		runtime.ensureConfig(ctx.cwd);
		return runtime.config.consolidateWhenIdle === true;
	};

	pi.on("agent_start", (_event: unknown, ctx: ConsolidationCtx) => {
		if (!idleMode(ctx)) {
			maybeLaunchConsolidation(pi, runtime, ctx);
			return;
		}
		// The session model is about to be called: get memory workers off the
		// shared server. Coverage markers are only appended on success, so an
		// aborted run simply retries after the next settled event.
		if (runtime.abortConsolidation?.()) {
			debugLog("consolidation.aborted", { reason: "agent_start" });
			if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
				"Observational memory: memory workers paused while the agent runs (consolidateWhenIdle)",
				"info",
			);
		}
	});
	pi.on("turn_end", (_event: unknown, ctx: ConsolidationCtx) => {
		if (idleMode(ctx)) return;
		maybeLaunchConsolidation(pi, runtime, ctx);
	});
	pi.on("agent_settled", (_event: unknown, ctx: ConsolidationCtx) => {
		if (!idleMode(ctx)) return;
		maybeLaunchConsolidation(pi, runtime, ctx);
	});
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string; sessionFile?: string } {
	try {
		return {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionFile: ctx.sessionManager.getSessionFile?.(),
		};
	} catch {
		return {};
	}
}

/** The session a backoff belongs to, so a backoff never carries over to another session. */
function sessionIdentity(ctx: ConsolidationCtx): string | undefined {
	const metadata = debugSessionMetadata(ctx);
	return metadata.sessionId ?? metadata.sessionFile;
}

/** Launch a consolidation run when any stage is due. Returns its promise, or undefined when nothing launched. */
function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): Promise<void> | undefined {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return undefined;
	if (runtime.consolidationInFlight) return undefined;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!anyStageDue(entries, runtime, ctx)) return undefined;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		getContextUsage: ctx.getContextUsage,
		sessionManager: ctx.sessionManager,
	};

	const sessionMetadata = debugSessionMetadata(ctx);
	return runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
}

function consolidationSignal(runtime: Runtime): AbortSignal | undefined {
	return runtime.consolidationAbortController?.signal;
}

function wasAborted(runtime: Runtime): boolean {
	return consolidationSignal(runtime)?.aborted === true;
}

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
): Promise<void> {
	const resolver = makeModelResolver(runtime, ctx);

	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolver);
		if (observerOutcome === "abort") return;
	} catch (error) {
		if (wasAborted(runtime)) return;
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}
	if (wasAborted(runtime)) return;

	runtime.consolidationPhase = "reflector";
	try {
		await runReflectorStage(pi, runtime, ctx, resolver);
	} catch (error) {
		if (wasAborted(runtime)) return;
		debugLog("reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
	}
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const tokens = observerTokens(entries, realContextTokens(ctx));
	if (tokens < runtime.config.observeAfterTokens) return "continue";

	const identity = sessionIdentity(ctx);
	const coverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);

	// Deliberate-empty backoff (#23): an intentional "nothing to record" verdict
	// must not re-fire the observer every turn over the same span. Retry only
	// after another observeAfterTokens worth of new source tokens arrives, and
	// drop the backoff as soon as coverage advances.
	const backoff = runtime.observerEmptyBackoff;
	if (backoff) {
		if (
			identity !== backoff.sessionIdentity
			|| coverageId !== backoff.coverageId
			|| tokens >= backoff.tokensAtEmpty + runtime.config.observeAfterTokens
		) {
			runtime.observerEmptyBackoff = undefined;
		} else {
			debugLog("observer.empty_backoff", { tokens, resumeAtTokens: backoff.tokensAtEmpty + runtime.config.observeAfterTokens });
			return "continue";
		}
	}

	// Resolve the model before building the chunk: the default chunk cap
	// derives from the resolved model's context window.
	const resolved = await resolver.resolve("observer");
	if (!resolved) return "abort";
	if (wasAborted(runtime)) {
		debugLog("observer.aborted", {});
		return "abort";
	}

	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const backlogEntries = sourceEntriesAfter(entries, lastCoverageIdx);

	// Budget the text that is actually sent to the observer, including source
	// labels and rendered message content. Complete entries are kept intact.
	// Only a first entry that cannot fit by itself is represented by a clearly
	// marked head/tail excerpt; the original ledger entry remains untouched.
	const contextWindow = observerChunkContextWindow(runtime, ctx, resolved);
	const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
	const {
		text: chunk,
		sourceEntryIds,
		estimatedTokens: chunkTokens,
		truncatedSourceEntryIds,
	} = serializeSourceAddressedBranchEntries(backlogEntries, { maxTokens: maxChunkTokens });
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";
	const coversUpToId = sourceEntryIds.at(-1);
	if (!coversUpToId) return "continue";

	if (sourceEntryIds.length < backlogEntries.length || truncatedSourceEntryIds.length > 0) {
		debugLog("observer.chunk_capped", {
			maxChunkTokens,
			backlogEntries: backlogEntries.length,
			backlogTokens: tokens,
			chunkEntries: sourceEntryIds.length,
			chunkTokens,
			truncatedSourceEntryIds,
		});
	}

	const fullMemory = fullProjection(entries);
	const memory = boundWorkerMemory(fullMemory.reflections, fullMemory.observations, resolveWorkerMemoryMaxTokens(runtime.config, contextWindow));
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk`,
		"info",
	);
	debugLog("observer.start", {
		tokens,
		chunkTokens,
		coversUpToId,
		sourceEntryIds,
		sourceEntryCount: sourceEntryIds.length,
		priorReflections: priorReflections.length,
		priorObservations: priorObservations.length,
		omittedReflections: memory.omittedReflections,
		omittedObservations: memory.omittedObservations,
	});

	let observations: Observation[] | undefined;
	try {
		observations = await resolver.runStage("observer", resolved, (worker) => runObserver({
			model: worker.model as any,
			priorReflections,
			priorObservations,
			chunk,
			allowedSourceEntryIds: sourceEntryIds,
			maxTurns: runtime.config.agentMaxTurns,
			maxOutputTokens: runtime.config.agentMaxTokens,
			signal: consolidationSignal(runtime),
			thinkingLevel: workerThinkingLevel(runtime, worker),
			modelRegistry: ctx.modelRegistry,
		}), consolidationSignal(runtime));
	} catch (error) {
		if (wasAborted(runtime)) {
			debugLog("observer.aborted", { coversUpToId });
			return "abort";
		}
		if (error instanceof ObserverStreamError) {
			// API/stream failure is not a clean empty (#32): surface it as a real
			// failure instead of the "no observations" path. Coverage stays put.
			runtime.recordConsolidationStageError(ctx, "observer", error);
			return "abort";
		}
		throw error;
	}
	if (wasAborted(runtime)) {
		debugLog("observer.aborted", { coversUpToId });
		return "abort";
	}
	if (!observations || observations.length === 0) {
		// Deliberate empty: routine info, not a warning, and back off re-fires
		// over the same span (#23).
		debugLog("observer.empty", { coversUpToId });
		runtime.observerEmptyBackoff = { sessionIdentity: identity, coverageId, tokensAtEmpty: tokens };
		if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
			"Observational memory: observer found nothing new in this chunk (coverage unchanged; will retry later)",
			"info",
		);
		return "continue";
	}
	runtime.observerEmptyBackoff = undefined;

	const data = buildObservationsRecordedData(observations, coversUpToId);
	if (!data) return "continue";
	debugLog("observer.records", {
		count: observations.length,
		observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
		coversUpToId,
	});
	if (!recordMemoryEntry(pi, runtime.config, ctx, entries, OM_OBSERVATIONS_RECORDED, data)) return "abort";
	debugLog("observer.appended", { count: observations.length, coversUpToId });
	return "continue";
}

async function runReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const identity = sessionIdentity(ctx);
	const currentTokens = realContextTokens(ctx);
	if (!reflectorDue(entries, runtime, currentTokens, identity)) return "continue";
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return "continue";

	const folded = foldLedger(entries);
	const pool = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
	const tokens = reflectorTokens(entries, currentTokens);
	debugLog("reflector.stage_start", {
		observationCoverageId,
		tokens,
		activeObservationCount: pool.activeObservationCount,
		observationTokens: pool.observationTokens,
		maxTokens: runtime.config.observationsPoolMaxTokens,
		targetTokens: pool.targetTokens,
		maxDropsAllowed: pool.maxDropsAllowed,
	});
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: reflector running (~${tokens.toLocaleString()} tokens) — active observation pool ~${pool.observationTokens.toLocaleString()} / ${pool.targetTokens.toLocaleString()} target tokens`,
		"info",
	);
	const resolved = await resolver.resolve("reflector");
	if (!resolved) return "abort";
	if (wasAborted(runtime)) {
		debugLog("reflector.aborted", {});
		return "abort";
	}

	const result = await resolver.runStage("reflector", resolved, (worker) => {
		// Consolidation condenses and drops older observations first, so the pass sees the oldest that fit.
		const memory = boundWorkerMemory(
			folded.reflections,
			folded.activeObservations,
			resolveWorkerMemoryMaxTokens(runtime.config, (worker.model as { contextWindow?: number }).contextWindow),
			{ observationsFrom: "oldest" },
		);
		return runReflector({
			model: worker.model as any,
			reflections: memory.reflections,
			observations: memory.observations,
			pool,
			maxTurns: runtime.config.agentMaxTurns,
			maxOutputTokens: runtime.config.agentMaxTokens,
			signal: consolidationSignal(runtime),
			thinkingLevel: workerThinkingLevel(runtime, worker),
			modelRegistry: ctx.modelRegistry,
		});
	}, consolidationSignal(runtime));
	if (wasAborted(runtime)) {
		debugLog("reflector.aborted", {});
		return "abort";
	}
	if (!result) {
		runtime.reflectorEmptyBackoff = { sessionIdentity: identity, passMarkerId: latestReflectorPassMarkerId(entries), tokensAtEmpty: tokens };
		debugLog("reflector.empty", { observationCoverageId, tokens });
		return "continue";
	}
	runtime.reflectorEmptyBackoff = undefined;

	// Both entries claim the same coverage: the pass read every observation recorded up to it.
	const reflectionsData = buildReflectionsRecordedData(result.reflections, observationCoverageId);
	if (reflectionsData && !recordMemoryEntry(pi, runtime.config, ctx, entries, OM_REFLECTIONS_RECORDED, reflectionsData)) return "abort";
	const dropsData = buildObservationsDroppedData(result.droppedObservationIds, observationCoverageId);
	if (dropsData && !recordMemoryEntry(pi, runtime.config, ctx, entries, OM_OBSERVATIONS_DROPPED, dropsData)) return "abort";
	return "continue";
}
