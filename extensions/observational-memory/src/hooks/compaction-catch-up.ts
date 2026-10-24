import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runObserver } from "../agents/observer/agent.ts";
import { resolveObserverChunkMaxTokens, resolveWorkerMemoryMaxTokens } from "../config.ts";
import { debugLog } from "../debug-log.ts";
import { recordMemoryEntry } from "../memory-journal.ts";
import type { Runtime } from "../runtime.ts";
import { serializeSourceAddressedBranchEntries } from "../serialize.ts";
import { makeModelResolver, observerChunkContextWindow, runStageWithFallback, workerThinkingLevel } from "../worker-models.ts";
import {
	OM_OBSERVATIONS_RECORDED,
	boundWorkerMemory,
	buildObservationsRecordedData,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	observationToSummaryLine,
	reflectionToSummaryLine,
	type Entry,
	type UnobservedSourceSpan,
} from "../session-ledger/index.ts";

export type CatchUpResult = {
	/** Observer chunks that recorded observations. */
	chunksRecorded: number;
	/** Why catch-up stopped before covering the whole gap, if it did. */
	stoppedBecause?: "max_chunks" | "empty" | "error" | "model_unavailable" | "aborted" | "branch_moved";
};

export type CatchUpArgs = {
	pi: ExtensionAPI;
	runtime: Runtime;
	ctx: ExtensionContext;
	entries: Entry[];
	gap: UnobservedSourceSpan;
	maxChunks: number;
	signal?: AbortSignal;
};

/**
 * Observe the unobserved source entries before Pi's proposed cut, one observer
 * chunk at a time, appending coverage as it goes. Runs inside
 * `session_before_compact`, where Pi waits for the hook and no session request
 * is in flight, so the memory model call does not compete with the session.
 * Each recorded chunk advances the observation frontier; the caller re-resolves
 * the cut afterwards. A chunk that yields no observations, fails, or hits the
 * chunk cap stops the catch-up and the remaining gap is handled as before
 * (retained or postponed). Nothing is ever appended for a failed chunk.
 */
export async function catchUpObserver(args: CatchUpArgs): Promise<CatchUpResult> {
	const { pi, runtime, ctx, entries, gap, maxChunks, signal } = args;
	const result: CatchUpResult = { chunksRecorded: 0 };
	if (maxChunks <= 0) return result;

	const resolver = makeModelResolver(runtime, ctx);
	let resolved = await resolver.resolve("observer");
	if (!resolved) return { ...result, stoppedBecause: "model_unavailable" };

	// Sized for the smaller of the primary and fallback windows, so a fallback retry fits.
	const contextWindow = observerChunkContextWindow(runtime, ctx, resolved);
	const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
	// Start at the global observation frontier, not at the gap (which begins
	// at the retained-range start). A coverage marker claims everything before
	// it, so starting later would mark unread source between the frontier and
	// the range start as observed and the background observer would never
	// revisit it.
	const frontierIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	let remaining = entries.slice(frontierIndex + 1, gap.lastIndex + 1).filter(isSourceEntry);
	let branch = entries;

	for (let chunkIndex = 0; chunkIndex < maxChunks && remaining.length > 0; chunkIndex++) {
		if (signal?.aborted) return { ...result, stoppedBecause: "aborted" };

		const { text: chunk, sourceEntryIds, estimatedTokens } = serializeSourceAddressedBranchEntries(remaining, { maxTokens: maxChunkTokens });
		const coversUpToId = sourceEntryIds.at(-1);
		if (!chunk.trim() || !coversUpToId) break;

		const fullMemory = fullProjection(branch);
		const memory = boundWorkerMemory(fullMemory.reflections, fullMemory.observations, resolveWorkerMemoryMaxTokens(runtime.config, contextWindow));
		if (runtime.config.showWorkerNotifications && ctx.hasUI) {
			ctx.ui.notify(
				`Observational memory: observing ${sourceEntryIds.length} unobserved source entr${sourceEntryIds.length === 1 ? "y" : "ies"} (~${estimatedTokens.toLocaleString()} tokens) before compacting`,
				"info",
			);
		}
		debugLog("compaction.catch_up.chunk", { chunkIndex, sourceEntryCount: sourceEntryIds.length, estimatedTokens, coversUpToId });

		let observations;
		try {
			observations = await runStageWithFallback(ctx, "observer", resolved, resolver, (worker) => runObserver({
				model: worker.model as any,
				priorReflections: memory.reflections.map(reflectionToSummaryLine),
				priorObservations: memory.observations.map(observationToSummaryLine),
				chunk,
				allowedSourceEntryIds: sourceEntryIds,
				signal,
				maxTurns: runtime.config.agentMaxTurns,
				maxOutputTokens: runtime.config.agentMaxTokens,
				thinkingLevel: workerThinkingLevel(runtime, worker),
				modelRegistry: ctx.modelRegistry,
			}), signal);
			// Later chunks go straight to the fallback once it took over.
			resolved = (await resolver.resolve("observer")) ?? resolved;
		} catch (error) {
			if (signal?.aborted) return { ...result, stoppedBecause: "aborted" };
			const errorMessage = error instanceof Error ? error.message : String(error);
			debugLog("compaction.catch_up.error", { chunkIndex, errorMessage });
			if (ctx.hasUI) ctx.ui.notify(`Observational memory: catch-up observer failed: ${errorMessage}`, "warning");
			return { ...result, stoppedBecause: "error" };
		}

		const data = observations && observations.length > 0 ? buildObservationsRecordedData(observations, coversUpToId) : undefined;
		if (!data) {
			debugLog("compaction.catch_up.empty", { chunkIndex, coversUpToId });
			return { ...result, stoppedBecause: "empty" };
		}

		if (!recordMemoryEntry(pi, runtime.config, ctx, branch, OM_OBSERVATIONS_RECORDED, data)) {
			return { ...result, stoppedBecause: "branch_moved" };
		}
		result.chunksRecorded++;
		debugLog("compaction.catch_up.recorded", { chunkIndex, count: observations!.length, coversUpToId });

		// Coverage is positional: everything at or before the marker counts as
		// covered, including entries the serializer skipped for lack of
		// renderable content (e.g. an aborted assistant message).
		const coveredIndex = entries.findIndex((entry) => entry.id === coversUpToId);
		remaining = remaining.filter((entry) => entries.indexOf(entry) > coveredIndex);
		branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? branch;
	}

	if (remaining.length > 0 && !result.stoppedBecause) result.stoppedBecause = "max_chunks";
	return result;
}
