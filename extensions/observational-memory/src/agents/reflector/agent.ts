import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.ts";
import { hashId } from "../../ids.ts";
import { runWorkerConversation, type WorkerModelRegistry } from "../worker-stream.ts";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.ts";
import { truncateRecordContent } from "../../serialize.ts";
import { REFLECTOR_DROP_SYSTEM, REFLECTOR_SYSTEM } from "./prompts.ts";
import { estimateStringTokens } from "../../tokens.ts";
import { reflectionToSummaryLine, type Observation, type Reflection } from "../../session-ledger/index.ts";
import {
	REFLECTION_COVERAGE_DROP_RANK,
	coverageTierForObservation,
	reflectionCoverageMap,
	summarizeCoverageByRelevance,
	summarizeCoverageByRelevanceForIds,
	summarizeCoverageTransitionsByRelevance,
	type ReflectionCoverageTier,
} from "./coverage.ts";
import type { ObservationPoolMetrics } from "./pool.ts";

export class ReflectorStreamError extends Error {
	readonly stopReason: string;
	constructor(stopReason: string, errorMessage?: string) {
		super(`reflector stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`);
		this.name = "ReflectorStreamError";
		this.stopReason = stopReason;
	}
}

/** What one reflector pass changes: new reflections and the observation ids it drops. Never both empty. */
export type ReflectorResult = {
	reflections: Reflection[];
	droppedObservationIds: string[];
};

interface RunReflectorArgs {
	model: Model<any>;
	reflections: Reflection[];
	/** Active observations the pass may reflect on and drop. */
	observations: Observation[];
	/** Metrics of the whole active pool; `maxDropsAllowed` caps the drops of this pass, and 0 makes it reflect only. */
	pool: ObservationPoolMetrics;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	/** Maximum output tokens for the loop (defaults to {@link AGENT_LOOP_MAX_TOKENS}). */
	maxOutputTokens?: number;
	thinkingLevel?: ModelThinkingLevel;
	modelRegistry: WorkerModelRegistry;
}

const RecordReflectionsSchema = Type.Object({
	reflections: Type.Array(
		Type.Object({
			content: Type.String({ minLength: 1 }),
			supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		}),
		{ minItems: 1 },
	),
});

type RecordReflectionsArgs = Static<typeof RecordReflectionsSchema>;

const DropObservationsSchema = Type.Object({
	ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	reason: Type.Optional(Type.String()),
});

type DropObservationsArgs = Static<typeof DropObservationsSchema>;

const RELEVANCE_DROP_RANK: Record<Observation["relevance"], number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function observationToReflectorLine(
	observation: Observation,
	coverage: ReflectionCoverageTier,
): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
}

export function summarizeSupportIdCounts(reflections: readonly Reflection[]): {
	reflectionCount: number;
	totalSupportIds: number;
	minSupportIds: number;
	maxSupportIds: number;
	averageSupportIds: number;
	histogram: Record<string, number>;
} {
	if (reflections.length === 0) {
		return { reflectionCount: 0, totalSupportIds: 0, minSupportIds: 0, maxSupportIds: 0, averageSupportIds: 0, histogram: {} };
	}
	const counts = reflections.map((reflection) => reflection.supportingObservationIds.length);
	const totalSupportIds = counts.reduce((sum, count) => sum + count, 0);
	const histogram: Record<string, number> = {};
	for (const count of counts) histogram[String(count)] = (histogram[String(count)] ?? 0) + 1;
	return {
		reflectionCount: reflections.length,
		totalSupportIds,
		minSupportIds: Math.min(...counts),
		maxSupportIds: Math.max(...counts),
		averageSupportIds: totalSupportIds / reflections.length,
		histogram,
	};
}

export function normalizeSupportingObservationIds(
	supportingObservationIds: readonly string[] | undefined,
	allowedObservationIds: readonly string[],
): string[] | undefined {
	if (!supportingObservationIds || supportingObservationIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedObservationIds.length; i++) {
		if (!allowedOrder.has(allowedObservationIds[i])) allowedOrder.set(allowedObservationIds[i], i);
	}

	const seen = new Set<string>();
	for (const id of supportingObservationIds) {
		if (!allowedOrder.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

function normalizeReflectionContent(content: string): string | undefined {
	const normalized = truncateRecordContent(content.trim());
	if (!normalized || /\r|\n/.test(normalized)) return undefined;
	return normalized;
}

function timestampRank(timestamp: string): number {
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Keep at most `maxDrops` of the proposed ids, preferring stronger reflection
 * coverage, then lower relevance, then older observations, then proposal order.
 */
export function selectDropCandidates(
	ids: readonly string[],
	observations: readonly Observation[],
	maxDrops: number,
	reflections: readonly Reflection[] = [],
): string[] {
	if (maxDrops <= 0 || ids.length === 0) return [];

	const byId = new Map(observations.map((observation) => [observation.id, observation]));
	const coverageById = reflectionCoverageMap(observations, reflections);
	const firstProposalIndex = new Map<string, number>();
	for (let i = 0; i < ids.length; i++) {
		const id = ids[i];
		if (!firstProposalIndex.has(id)) firstProposalIndex.set(id, i);
	}

	return Array.from(firstProposalIndex.entries())
		.map(([id, index]) => ({ id, index, observation: byId.get(id) }))
		.filter((candidate): candidate is { id: string; index: number; observation: Observation } =>
			candidate.observation !== undefined
		)
		.sort((a, b) => {
			const coverageDelta = REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(a.observation, coverageById)]
				- REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(b.observation, coverageById)];
			const relevanceDelta = RELEVANCE_DROP_RANK[a.observation.relevance] - RELEVANCE_DROP_RANK[b.observation.relevance];
			const ageDelta = timestampRank(a.observation.timestamp) - timestampRank(b.observation.timestamp);
			return coverageDelta || relevanceDelta || ageDelta || a.index - b.index;
		})
		.slice(0, maxDrops)
		.map((candidate) => candidate.id);
}

/**
 * One reflector pass: record new durable reflections and, when the active pool
 * is over its target, drop the safest observations toward it. Returns
 * undefined when the pass changes nothing.
 */
export async function runReflector(args: RunReflectorArgs): Promise<ReflectorResult | undefined> {
	const { model, reflections, observations, pool, signal } = args;
	if (observations.length === 0) return undefined;

	const coverageById = reflectionCoverageMap(observations, reflections);
	debugLog("reflector.agent_start", {
		activeObservationCount: observations.length,
		reflectionCount: reflections.length,
		observationTokens: pool.observationTokens,
		targetTokens: pool.targetTokens,
		maxDropsAllowed: pool.maxDropsAllowed,
		coverageSummaryByRelevance: summarizeCoverageByRelevance(observations, coverageById),
	});

	const allowedObservationIds = observations.map((observation) => observation.id);
	const allowedObservations = new Map(observations.map((observation) => [observation.id, observation]));
	const existingReflectionIds = new Set(reflections.map((reflection) => reflection.id));
	const accumulated = new Map<string, Reflection>();
	const proposedDropIds: string[] = [];
	let reflectionToolCalls = 0;
	let dropToolCalls = 0;
	let rejectedReflectionCount = 0;
	let duplicateReflectionCount = 0;
	let missingDropIdsCount = 0;

	const recordReflections: AgentTool<typeof RecordReflectionsSchema> = {
		name: "record_reflections",
		label: "Record reflections",
		description: "Record new durable reflections with supporting observation ids.",
		parameters: RecordReflectionsSchema,
		execute: async (_id, params: RecordReflectionsArgs) => {
			reflectionToolCalls++;
			let added = 0;
			let duplicates = 0;
			let rejected = 0;
			const supported = new Set<string>();
			for (const proposal of params.reflections) {
				const content = normalizeReflectionContent(proposal.content);
				const supportingObservationIds = normalizeSupportingObservationIds(proposal.supportingObservationIds, allowedObservationIds);
				if (!content || !supportingObservationIds) {
					rejected++;
					continue;
				}
				const id = hashId(content);
				if (existingReflectionIds.has(id) || accumulated.has(id)) {
					duplicates++;
					continue;
				}
				accumulated.set(id, { id, content, supportingObservationIds, tokenCount: estimateStringTokens(content) });
				for (const observationId of supportingObservationIds) supported.add(observationId);
				added++;
			}
			duplicateReflectionCount += duplicates;
			rejectedReflectionCount += rejected;
			const supportedPart = supported.size > 0 ? ` Observations these reflections now support: ${Array.from(supported).join(", ")}.` : "";
			return {
				content: [{ type: "text", text: `Recorded ${added} reflection${added === 1 ? "" : "s"}; ${duplicates} duplicate${duplicates === 1 ? "" : "s"}; ${rejected} rejected. Total this run: ${accumulated.size}.${supportedPart}` }],
				details: { added, duplicates, rejected, total: accumulated.size },
			};
		},
	};

	const dropObservations: AgentTool<typeof DropObservationsSchema> = {
		name: "drop_observations",
		label: "Drop observations",
		description: "Propose active observation ids that are safe to remove from compacted memory.",
		parameters: DropObservationsSchema,
		execute: async (_id, params: DropObservationsArgs) => {
			dropToolCalls++;
			let added = 0;
			for (const id of params.ids) {
				if (!allowedObservations.has(id)) {
					missingDropIdsCount++;
					continue;
				}
				if (proposedDropIds.includes(id)) continue;
				proposedDropIds.push(id);
				added++;
			}
			return {
				content: [{ type: "text", text: `Queued ${added} drop candidate${added === 1 ? "" : "s"}. Candidates this run: ${proposedDropIds.length}. Maximum drops allowed: ${pool.maxDropsAllowed}.` }],
				details: { added, totalCandidates: proposedDropIds.length, maxDropsAllowed: pool.maxDropsAllowed },
			};
		},
	};

	const memoryText = `CURRENT REFLECTIONS:
${joinOrEmpty(reflections.map(reflectionToSummaryLine))}

CURRENT OBSERVATIONS:
${joinOrEmpty(observations.map((observation) => observationToReflectorLine(observation, coverageTierForObservation(observation, coverageById))))}`;
	const dropsAllowed = pool.maxDropsAllowed > 0;
	const userText = dropsAllowed
		? `${memoryText}

Active observation pool: ~${pool.observationTokens.toLocaleString()} tokens; target: ~${pool.targetTokens.toLocaleString()} tokens; fullness against target: ~${Math.round(pool.fullness * 100).toLocaleString()}%; over target by ~${pool.tokensOverTarget.toLocaleString()} tokens.
Maximum drops allowed this run: ${pool.maxDropsAllowed.toLocaleString()} observation${pool.maxDropsAllowed === 1 ? "" : "s"}. This maximum is a hard upper bound, not a target. Drop fewer or none if fewer observations are clearly safe.

First crystallize any missing durable reflections with record_reflections, then drop the safest observations with drop_observations.`
		: `${memoryText}

Crystallize any missing durable facts or patterns into new reflections. If nothing is stable enough, do not call the tool.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = {
		messages: [{ role: "system", content: dropsAllowed ? REFLECTOR_DROP_SYSTEM : REFLECTOR_SYSTEM, timestamp: Date.now() }],
		tools: dropsAllowed ? [recordReflections as AgentTool<any>, dropObservations as AgentTool<any>] : [recordReflections as AgentTool<any>],
	};
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		maxTokens: boundedMaxTokens(model, args.maxOutputTokens ?? AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined
			? {
				finishTurn: (turn) => {
					if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return;
					return ++turnCount >= effectiveMaxTurns ? { action: "end" } : undefined;
				},
			}
			: {}),
	};

	// Tool execution collects the results; the conversation reports only a failed last turn.
	const streamError = await runWorkerConversation({
		stage: "reflector",
		registry: args.modelRegistry,
		loop: args.agentLoop ?? agentLoop,
		prompts,
		context,
		config,
		signal,
	});
	const acceptedReflections = Array.from(accumulated.values());
	const afterReflections = [...reflections, ...acceptedReflections];
	const droppedObservationIds = selectDropCandidates(proposedDropIds, observations, pool.maxDropsAllowed, afterReflections);
	const changed = acceptedReflections.length > 0 || droppedObservationIds.length > 0;
	if (!changed && streamError) throw new ReflectorStreamError(streamError.stopReason, streamError.errorMessage);
	const afterCoverageById = reflectionCoverageMap(observations, afterReflections);
	debugLog("reflector.result", {
		reason: changed ? "accepted_nonempty" : reflectionToolCalls + dropToolCalls === 0 ? "no_tool_call" : "all_filtered",
		reflectionToolCalls,
		dropToolCalls,
		acceptedReflectionCount: acceptedReflections.length,
		duplicateReflectionCount,
		rejectedReflectionCount,
		acceptedSupportIdCounts: summarizeSupportIdCounts(acceptedReflections),
		coverageTransitionsByRelevance: summarizeCoverageTransitionsByRelevance(observations, coverageById, afterCoverageById),
		proposedDropCount: proposedDropIds.length,
		missingDropIdsCount,
		selectedDropsCount: droppedObservationIds.length,
		selectedDropTokens: droppedObservationIds.reduce((sum, id) => sum + (allowedObservations.get(id)?.tokenCount ?? 0), 0),
		selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(droppedObservationIds, observations, afterCoverageById),
		maxDropsAllowed: pool.maxDropsAllowed,
	});
	return changed ? { reflections: acceptedReflections, droppedObservationIds } : undefined;
}
