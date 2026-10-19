import {
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { resolveCompactionMaxRetainedTokens, resolveCompactionSummaryMaxTokens } from "../config.ts";
import { estimateStringTokens } from "../tokens.ts";
import { debugLog, withDebugLogContext, type DebugLogContext } from "../debug-log.ts";
import type { Runtime } from "../runtime.ts";
import { catchUpObserver } from "./compaction-catch-up.ts";
import {
	OM_OBSERVATIONS_RECORDED,
	buildCompactionProjection,
	compactionRangeStartIndex,
	entryIndexForId,
	latestCoverageIndex,
	latestCoverageMarkerId,
	rawTokensAfterIndex,
	renderSummaryWithBudget,
	unobservedSourceSpanBefore,
	type Entry,
	type UnobservedSourceSpan,
} from "../session-ledger/index.ts";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

/**
 * Context-visible message roles Pi accepts as a compaction cut point (mirrors
 * Pi's `isCutPointMessage`): never a tool result, which must follow its call.
 * Cutting at an assistant message keeps its tool results with it.
 */
const CUT_POINT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

function isCutPointEntry(entry: Entry): boolean {
	if (entry.type === "compaction") return false;
	try {
		return sessionEntryToContextMessages(entry as unknown as SessionEntry).some((message) => CUT_POINT_ROLES.has(message.role));
	} catch {
		return false;
	}
}

/** Nearest valid cut point at or before `index`, not before `startIndex`; -1 when none. */
export function findCutPointAtOrBefore(entries: Entry[], index: number, startIndex: number): number {
	for (let i = Math.min(index, entries.length - 1); i >= startIndex && i >= 0; i--) {
		if (isCutPointEntry(entries[i])) return i;
	}
	return -1;
}

export type CompactionCut = {
	/** First entry Pi keeps in context. */
	firstKeptEntryId: string;
	/** Entry through which the memory ledger is folded into the rendered summary. */
	foldThroughEntryId: string;
};

/**
 * Entry through which a cut at `firstKeptEntryId` folds the memory ledger.
 * The latest observer chunk may straddle the cut: its coverage marker lies in
 * the retained tail, yet its observations also describe the discarded entries
 * before the cut. Folding only through the cut would drop that chunk, so the
 * fold runs through its coverage marker; the overlap with the retained
 * history is redundant, never lost.
 */
function foldThroughEntryIdFor(entries: Entry[], firstKeptEntryId: string): string {
	const cutIndex = entryIndexForId(entries, firstKeptEntryId);
	const coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	return cutIndex !== -1 && coverageIndex > cutIndex ? entries[coverageIndex].id : firstKeptEntryId;
}

export type CompactionCutResolution =
	| { kind: "cut"; cut: CompactionCut; gap?: UnobservedSourceSpan; retainedTokens?: number }
	| { kind: "uncovered"; reason: string; gap: UnobservedSourceSpan };

/** What the hook returns to Pi: never `undefined`, which would hand the compaction to Pi's own summarizer. */
type CompactionDecision =
	| { cancel: true }
	| { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown } };

/**
 * Decide where this compaction cuts.
 *
 * Pi proposes `firstKeptEntryId` from its own `keepRecentTokens` budget. The
 * observer may not have reached that point yet: every source entry between the
 * observation frontier and Pi's cut would then be discarded with no memory
 * describing it. When that happens, retain those entries by moving the
 * boundary back to the nearest valid cut point at or before the first
 * unobserved entry (the entry itself, or the assistant message whose tool
 * result it is), and fold every recorded observation into the summary (a
 * retained source that is also described by an observation is redundant,
 * never lost). If retaining is not possible, or exceeds the retained-tail
 * budget, report the gap as uncovered: the hook then postpones, or during
 * overflow recovery cuts at Pi's boundary and names the gap in the summary.
 */
export function resolveCompactionCut(
	entries: Entry[],
	firstKeptEntryId: string,
	options: { maxRetainedTokens: number; reason?: string },
): CompactionCutResolution {
	const cutIndex = entryIndexForId(entries, firstKeptEntryId);
	if (cutIndex === -1) return { kind: "cut", cut: { firstKeptEntryId, foldThroughEntryId: firstKeptEntryId } };

	const gap = unobservedSourceSpanBefore(entries, cutIndex);
	if (!gap) return { kind: "cut", cut: { firstKeptEntryId, foldThroughEntryId: foldThroughEntryIdFor(entries, firstKeptEntryId) } };

	// Overflow recovery must free context now; retaining more than Pi asked
	// for risks overflowing again on the retried turn.
	if (options.reason === "overflow") return { kind: "uncovered", reason: "overflow recovery", gap };

	const coverageMarkerId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!coverageMarkerId) return { kind: "uncovered", reason: "no observation coverage", gap };

	// Only source the observer has covered inside the current compaction range
	// can be folded. Compare source tokens, not indices: Pi's retention
	// boundary may sit on a metadata entry (memory ledger rows carry no context
	// tokens), and cutting one entry past it would free nothing while writing a
	// new compaction entry every time Pi's threshold fires.
	const rangeStart = compactionRangeStartIndex(entries);
	const coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	if (coverageIndex < rangeStart) return { kind: "uncovered", reason: "nothing observed can be compacted", gap };

	const safeCutIndex = findCutPointAtOrBefore(entries, gap.firstIndex, rangeStart);
	if (safeCutIndex <= rangeStart) return { kind: "uncovered", reason: "nothing observed can be compacted", gap };
	const freedTokens = rawTokensAfterIndex(entries, rangeStart - 1) - rawTokensAfterIndex(entries, safeCutIndex - 1);
	if (freedTokens <= 0) return { kind: "uncovered", reason: "nothing observed can be compacted", gap };

	const retainedTokens = rawTokensAfterIndex(entries, safeCutIndex - 1);
	if (retainedTokens > options.maxRetainedTokens) {
		return {
			kind: "uncovered",
			reason: `retaining ~${retainedTokens.toLocaleString()} tokens exceeds the ~${options.maxRetainedTokens.toLocaleString()}-token budget`,
			gap,
		};
	}

	return {
		kind: "cut",
		cut: { firstKeptEntryId: entries[safeCutIndex].id, foldThroughEntryId: coverageMarkerId },
		gap,
		retainedTokens,
	};
}

function gapLabel(gap: UnobservedSourceSpan): string {
	return `${gap.entryCount} source entr${gap.entryCount === 1 ? "y" : "ies"} (~${gap.tokens.toLocaleString()} tokens)`;
}

export function debugContext(runtime: Runtime, ctx: ExtensionContext, label = "compaction"): DebugLogContext {
	let sessionId: string | undefined;
	let sessionFile: string | undefined;
	try {
		const manager = ctx.sessionManager as { getSessionId?: () => string; getSessionFile?: () => string | undefined } | undefined;
		sessionId = manager?.getSessionId?.();
		sessionFile = manager?.getSessionFile?.();
	} catch {
		// Debug metadata is best-effort.
	}
	return {
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		sessionId,
		sessionFile,
		runId: `${label}-${Date.now().toString(36)}`,
	};
}

async function handleCompaction(
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	runtime: Runtime,
): Promise<CompactionDecision> {
	const { preparation, branchEntries } = event;
	const { firstKeptEntryId, tokensBefore } = preparation;
	let entries = branchEntries as Entry[];
	const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
	const maxRetainedTokens = resolveCompactionMaxRetainedTokens(runtime.config, contextWindow);
	const summaryMaxTokens = resolveCompactionSummaryMaxTokens(runtime.config, contextWindow);
	const { reason } = event;
	let resolution = resolveCompactionCut(entries, firstKeptEntryId, { maxRetainedTokens, reason });

	// The background observer is behind Pi's cut. Rather than retaining the
	// tail or postponing, observe the gap now: Pi waits for this hook, so the
	// memory model has the server to itself, and observations are durable.
	// This also runs before the first coverage marker exists: there is nothing
	// better to do with an unobserved gap than observe it.
	if (
		resolution.gap
		&& runtime.config.compactionCatchUpMaxChunks > 0
		&& !runtime.consolidationInFlight
	) {
		const catchUp = await catchUpObserver({
			pi,
			runtime,
			ctx,
			entries,
			gap: resolution.gap,
			maxChunks: runtime.config.compactionCatchUpMaxChunks,
			signal: event.signal,
		});
		debugLog("compaction.catch_up", { ...catchUp, gapEntries: resolution.gap.entryCount, gapTokens: resolution.gap.tokens });
		if (catchUp.chunksRecorded > 0) {
			entries = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? entries;
			resolution = resolveCompactionCut(entries, firstKeptEntryId, { maxRetainedTokens, reason });
		}
	}

	let projection: ReturnType<typeof buildCompactionProjection> | undefined;
	let summary = "";
	if (resolution.kind === "cut") {
		projection = buildCompactionProjection(
			entries,
			resolution.cut.foldThroughEntryId,
			{ observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) },
		);
		const rendered = renderSummaryWithBudget(projection.reflections, projection.observations, { maxTokens: summaryMaxTokens });
		summary = rendered.text;
		// A summary that kept no record would replace older context with only
		// instructions and an omission notice; treat it as no summary at all.
		const hadRecords = projection.reflections.length + projection.observations.length > 0;
		if (hadRecords && rendered.reflections.length + rendered.observations.length === 0) {
			debugLog("compaction.summary_budget_empty", {
				summaryMaxTokens,
				reflections: projection.reflections.length,
				observations: projection.observations.length,
			});
			summary = "";
		}

		// A moved cut keeps the unobserved tail AND adds the rendered memory on
		// top of it. Both must fit the budget, or Pi's threshold fires again
		// right after this compaction and the next hook call cannot cut either.
		if (resolution.gap && resolution.retainedTokens !== undefined) {
			const summaryTokens = estimateStringTokens(summary);
			const afterTokens = resolution.retainedTokens + summaryTokens;
			if (afterTokens > maxRetainedTokens) {
				resolution = {
					kind: "uncovered",
					gap: resolution.gap,
					reason: `retaining ~${resolution.retainedTokens.toLocaleString()} tokens plus a ~${summaryTokens.toLocaleString()}-token memory summary exceeds the ~${maxRetainedTokens.toLocaleString()}-token budget`,
				};
			}
		}
	}

	if (resolution.gap) {
		debugLog("compaction.observer_behind", {
			proposedFirstKeptEntryId: firstKeptEntryId,
			unobservedEntries: resolution.gap.entryCount,
			unobservedTokens: resolution.gap.tokens,
			outcome: resolution.kind,
			...(resolution.kind === "cut"
				? {
					firstKeptEntryId: resolution.cut.firstKeptEntryId,
					foldThroughEntryId: resolution.cut.foldThroughEntryId,
					retainedTokens: resolution.retainedTokens,
					summaryTokens: estimateStringTokens(summary),
					maxRetainedTokens,
				}
				: { reason: resolution.reason }),
		});
	}

	if (resolution.kind === "uncovered" || !projection || summary.length === 0) {
		const why = resolution.kind === "uncovered" ? resolution.reason : "no memory record to render";
		return compactAtProposedCut(entries, event, ctx, runtime, { why, gap: resolution.gap, summaryMaxTokens });
	}

	if (resolution.gap && ctx.hasUI) {
		ctx.ui.notify(
			`Observational memory: observer has not reached ${gapLabel(resolution.gap)} before the compaction cut; keeping them in context until they are observed`,
			"info",
		);
	}

	return {
		compaction: {
			summary,
			firstKeptEntryId: resolution.cut.firstKeptEntryId,
			tokensBefore,
			details: projection.details,
		},
	};
}

/**
 * Compaction when the hook cannot produce a covered cut: Pi's cut would
 * discard entries the memory does not describe, or no record fits the summary.
 *
 * Cutting at Pi's boundary is lossless when the memory describes everything
 * before it. When it does not (an unobserved gap, or records that do not fit
 * the summary budget), manual and threshold compaction can wait: cancel, and
 * let the observer catch up before the next attempt. Overflow recovery must
 * free context now, so it cuts anyway and the summary names the gap. The gap
 * entries stay in the session file after the coverage marker, so the
 * background observer still records them and a later compaction carries them.
 */
function compactAtProposedCut(
	entries: Entry[],
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	runtime: Runtime,
	args: { why: string; gap?: UnobservedSourceSpan; summaryMaxTokens: number },
): CompactionDecision {
	const { firstKeptEntryId, tokensBefore } = event.preparation;
	const projection = buildCompactionProjection(entries, foldThroughEntryIdFor(entries, firstKeptEntryId), {
		observationsPoolMaxTokens: observationsPoolMaxTokens(runtime),
	});
	const rendered = renderSummaryWithBudget(projection.reflections, projection.observations, {
		maxTokens: args.summaryMaxTokens,
	});
	const renderedRecords = rendered.reflections.length + rendered.observations.length;
	const recordsLost = renderedRecords === 0 && projection.reflections.length + projection.observations.length > 0;
	// Instructions without a single record carry nothing; never write them alone.
	const memoryText = renderedRecords > 0 ? rendered.text : "";
	const lossy = args.gap !== undefined || recordsLost;

	if (lossy && event.reason !== "overflow") {
		debugLog("compaction.postponed", { why: args.why, gapEntries: args.gap?.entryCount, recordsLost });
		if (ctx.hasUI) {
			const detail = args.gap
				? `: observer has not reached ${gapLabel(args.gap)} before the compaction cut (${args.why})`
				: ` (${args.why})`;
			ctx.ui.notify(`Observational memory: compaction postponed${detail}`, "warning");
		}
		return { cancel: true };
	}

	const notice = args.gap
		? `[Observational memory: ${gapLabel(args.gap)} before this point left the context before the observer reached them; the memory above does not describe them yet.]`
		: "";
	const summary = [memoryText, notice].filter((part) => part.length > 0).join("\n\n")
		|| "[Observational memory: earlier context was compacted; no memory record describes it.]";
	debugLog("compaction.at_proposed_cut", { why: args.why, lossy, gapEntries: args.gap?.entryCount, gapTokens: args.gap?.tokens });
	if (lossy && ctx.hasUI) {
		ctx.ui.notify(
			`Observational memory: overflow recovery compacted without full memory coverage (${args.why})`,
			"warning",
		);
	}
	return { compaction: { summary, firstKeptEntryId, tokensBefore, details: projection.details } };
}

/**
 * A failure must not leave the decision to Pi: Pi's extension runner reports
 * an exception escaping this handler and treats it as no result, which runs
 * Pi's own summarizer. Manual and threshold compaction wait for the next
 * attempt. Overflow recovery must free context, so it cuts at Pi's boundary
 * with a notice; the ledger keeps every record, and the next compaction
 * renders it again.
 */
function compactionAfterFailure(event: SessionBeforeCompactEvent, ctx: ExtensionContext, error: unknown): CompactionDecision {
	const message = error instanceof Error ? error.message : String(error);
	if (event.reason !== "overflow") {
		if (ctx.hasUI) ctx.ui.notify(`Observational memory: compaction postponed after an error: ${message}`, "error");
		return { cancel: true };
	}
	if (ctx.hasUI) {
		ctx.ui.notify(`Observational memory: overflow recovery compacted without a memory summary after an error: ${message}`, "error");
	}
	const { firstKeptEntryId, tokensBefore } = event.preparation;
	return {
		compaction: {
			summary: "[Observational memory: earlier context was compacted after a memory error; no memory record describes it here.]",
			firstKeptEntryId,
			tokensBefore,
		},
	};
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<CompactionDecision> => {
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Observational memory: another compaction is already in progress; cancelling duplicate",
					"warning",
				);
			}
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			return await withDebugLogContext(debugContext(runtime, ctx), () => handleCompaction(pi, event, ctx, runtime));
		} catch (error) {
			return compactionAfterFailure(event, ctx, error);
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
