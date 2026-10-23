import type {
	CompactionEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	TurnEndEvent,
	TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";

import { resolveCompactAfterTokens, resolveCompactionSummaryMaxTokens } from "../config.ts";
import { debugLog, withDebugLogContext } from "../debug-log.ts";
import type { Runtime } from "../runtime.ts";
import {
	buildCompactionProjection,
	compactionRangeStartIndex,
	entryIndexForId,
	measuredSourceTokens,
	measuredTokensSinceLastCompaction,
	renderSummaryWithBudget,
	sumTokensAfterIndex,
	type Entry,
} from "../session-ledger/index.ts";
import { catchUpObserver } from "./compaction-catch-up.ts";
import { debugContext, findCutPointAtOrBefore, resolveCompactionCut, type CompactionCutResolution } from "./compaction-hook.ts";

/** Share of the activation threshold kept as raw history (Mastra's `bufferActivation: 0.8`). */
export const ACTIVATION_KEEP_RECENT_RATIO = 0.2;

/**
 * Retained raw history, relative to the activation threshold, at which
 * activation stops waiting for the background observer and observes the gap
 * synchronously (Mastra's `blockAfter: 1.2`).
 */
export const ACTIVATION_BLOCK_AFTER_RATIO = 1.2;

type ActivationPlan = {
	resolution?: CompactionCutResolution;
	/** Source tokens left in context after the cut, or the whole tail when nothing can be cut. */
	retainedTokens: number;
};

/** Latest valid cut point after the range start that keeps at least `keepRecentTokens` of source history; -1 when none. */
function keepRecentCutIndex(entries: Entry[], tokens: number[], rangeStart: number, keepRecentTokens: number): number {
	let kept = 0;
	for (let i = entries.length - 1; i > rangeStart; i--) {
		kept += tokens[i];
		if (kept >= keepRecentTokens) return findCutPointAtOrBefore(entries, i, rangeStart + 1);
	}
	return -1;
}

function planActivation(entries: Entry[], keepRecentTokens: number): ActivationPlan {
	const tokens = measuredSourceTokens(entries);
	const rangeStart = compactionRangeStartIndex(entries);
	const tailTokens = sumTokensAfterIndex(tokens, rangeStart - 1);
	const proposed = keepRecentCutIndex(entries, tokens, rangeStart, keepRecentTokens);
	if (proposed === -1) return { retainedTokens: tailTokens };

	// Activation frees whatever the observer has covered: a cut never passes
	// the first unobserved source entry, so nothing leaves the context
	// without a memory record describing it.
	const resolution = resolveCompactionCut(entries, entries[proposed].id, { maxRetainedTokens: Number.POSITIVE_INFINITY });
	if (resolution.kind === "uncovered") return { resolution, retainedTokens: tailTokens };
	const cutIndex = entryIndexForId(entries, resolution.cut.firstKeptEntryId);
	return { resolution, retainedTokens: sumTokensAfterIndex(tokens, cutIndex - 1) };
}

function branch(ctx: ExtensionContext): Entry[] {
	return ctx.sessionManager.getBranch() as Entry[];
}

async function activate(
	pi: ExtensionAPI,
	runtime: Runtime,
	event: TurnEndEvent,
	ctx: ExtensionContext,
): Promise<TurnEndEventResult | undefined> {
	if (event.outcome !== "completed") return undefined;
	if (event.entries.some((entry) => entry.type === "compaction")) return undefined;

	let entries = branch(ctx);
	const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
	const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
	const tailTokens = measuredTokensSinceLastCompaction(entries);
	if (tailTokens < threshold) return undefined;

	const keepRecentTokens = Math.floor(threshold * ACTIVATION_KEEP_RECENT_RATIO);
	const blockAfterTokens = Math.floor(threshold * ACTIVATION_BLOCK_AFTER_RATIO);
	let plan = planActivation(entries, keepRecentTokens);

	if (plan.retainedTokens >= blockAfterTokens && runtime.consolidationPromise) {
		debugLog("activation.wait_for_consolidation", { retainedTokens: plan.retainedTokens, blockAfterTokens });
		await runtime.consolidationPromise;
		entries = branch(ctx);
		plan = planActivation(entries, keepRecentTokens);
	}

	const gap = plan.resolution?.gap;
	if (
		plan.retainedTokens >= blockAfterTokens
		&& gap
		&& runtime.config.compactionCatchUpMaxChunks > 0
		&& !runtime.consolidationInFlight
	) {
		const catchUp = await catchUpObserver({
			pi,
			runtime,
			ctx,
			entries,
			gap,
			maxChunks: runtime.config.compactionCatchUpMaxChunks,
			signal: ctx.signal,
		});
		debugLog("activation.catch_up", { ...catchUp, gapEntries: gap.entryCount, gapTokens: gap.tokens });
		if (catchUp.chunksRecorded > 0) {
			entries = branch(ctx);
			plan = planActivation(entries, keepRecentTokens);
		}
	}

	const resolution = plan.resolution;
	if (resolution?.kind !== "cut") {
		debugLog("activation.waiting", {
			tailTokens,
			threshold,
			reason: resolution?.reason ?? "no cut point keeps the recent history",
		});
		return undefined;
	}

	const foldThroughEntryId = resolution.cut.foldThroughEntryId;
	const projection = buildCompactionProjection(entries, foldThroughEntryId, {
		observationsPoolMaxTokens: runtime.config.observationsPoolMaxTokens,
	});
	const rendered = renderSummaryWithBudget(projection.reflections, projection.observations, {
		maxTokens: resolveCompactionSummaryMaxTokens(runtime.config, contextWindow),
	});
	if (rendered.reflections.length + rendered.observations.length === 0) {
		debugLog("activation.summary_empty", {
			reflections: projection.reflections.length,
			observations: projection.observations.length,
		});
		return undefined;
	}

	debugLog("activation.compacted", {
		tailTokens,
		threshold,
		retainedTokens: plan.retainedTokens,
		firstKeptEntryId: resolution.cut.firstKeptEntryId,
		foldThroughEntryId,
		unobservedEntries: resolution.gap?.entryCount,
		reflections: rendered.reflections.length,
		observations: rendered.observations.length,
	});
	if (runtime.config.showWorkerNotifications && ctx.hasUI) {
		ctx.ui.notify(
			`Observational memory: activated memory over ~${(tailTokens - plan.retainedTokens).toLocaleString()} source tokens; ~${plan.retainedTokens.toLocaleString()} kept as history`,
			"info",
		);
	}

	const draft: CompactionEntryDraft = {
		type: "compaction",
		summary: rendered.text,
		firstKeptEntryId: resolution.cut.firstKeptEntryId,
		details: projection.details,
	};
	return { entries: [...event.entries, draft] };
}

/**
 * Activate memory at `turn_end`, Mastra style: once the source history in
 * context since the latest compaction boundary, counted in provider tokens
 * (`measuredSourceTokens`), reaches `compactAfterTokens`,
 * replace its observed part with the rendered memory and keep the newest
 * history raw. Pi persists the returned compaction entry before the next
 * model request, so activation also happens between the tool calls of one
 * agent run, without asking Pi to compact.
 */
export function registerActivation(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("turn_end", async (event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true) return undefined;
		return withDebugLogContext(debugContext(runtime, ctx, "activation"), () => activate(pi, runtime, event, ctx));
	});
}
