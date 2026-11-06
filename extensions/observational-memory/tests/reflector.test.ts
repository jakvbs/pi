import { describe, expect, it } from "vitest";

import {
	normalizeSupportingObservationIds,
	observationToReflectorLine,
	runReflector,
	selectDropCandidates,
	summarizeSupportIdCounts,
} from "../src/agents/reflector/agent.ts";
import { maxDropCountForPool, observationPoolFullness, observationPoolMetrics } from "../src/agents/reflector/pool.ts";
import { hashId } from "../src/ids.ts";
import { estimateStringTokens } from "../src/tokens.ts";
import { AGENT_LOOP_MAX_TOKENS } from "../src/model-budget.ts";
import { observation, reflection } from "./fixtures/session.ts";

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

const registry = { streamSimple: () => { throw new Error("the fake agent loop never streams"); } } as any;

function poolArgs(observations: ReturnType<typeof observation>[], targetTokens: number) {
	return { observations, pool: observationPoolMetrics(observations, targetTokens), modelRegistry: registry };
}

describe("runReflector maxTokens clamping", () => {
	const args = {
		reflections: [],
		...poolArgs([observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")], 0),
	};

	function captureLoopConfig() {
		let loopConfig: any;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			loopConfig = config;
		});
		return { loop, config: () => loopConfig };
	}

	it("clamps the loop maxTokens to a model whose maxTokens is below the configured budget", async () => {
		const { loop, config } = captureLoopConfig();

		await runReflector({
			...args,
			model: { maxTokens: 8_192 } as any,
			maxOutputTokens: 32_000,
			agentLoop: loop,
		});

		expect(config().maxTokens).toBe(8_192);
	});

	it("passes the configured maxOutputTokens through when the model advertises no maxTokens", async () => {
		const { loop, config } = captureLoopConfig();

		await runReflector({
			...args,
			model: {} as any,
			maxOutputTokens: 8_192,
			agentLoop: loop,
		});

		expect(config().maxTokens).toBe(8_192);
	});

	it("defaults the loop maxTokens to AGENT_LOOP_MAX_TOKENS", async () => {
		const { loop, config } = captureLoopConfig();

		await runReflector({ ...args, model: {} as any, agentLoop: loop });

		expect(config().maxTokens).toBe(AGENT_LOOP_MAX_TOKENS);
	});

	it("uses finishTurn as a reflector turn cap without overriding hard exits", async () => {
		const { loop, config } = captureLoopConfig();

		await runReflector({ ...args, model: {} as any, agentLoop: loop, maxTurns: 2 });

		expect(config().finishTurn).toBeTypeOf("function");
		expect(config().finishTurn({ message: { stopReason: "error" } })).toBeUndefined();
		expect(config().finishTurn({ message: { stopReason: "aborted" } })).toBeUndefined();
		expect(config().finishTurn({ message: { stopReason: "toolUse" } })).toBeUndefined();
		expect(config().finishTurn({ message: { stopReason: "stop" } })).toEqual({ action: "end" });
	});
});

describe("V3 reflector agent", () => {
	const obsA = observation("aaaaaaaaaaaa", { relevance: "medium" });
	const obsB = observation("bbbbbbbbbbbb", { relevance: "low" });
	const critical = observation("cccccccccccc", { relevance: "critical" });
	// Rendered observation lines: 19 + 18 + 19 = 56 tokens. A 20-token target allows 2 drops.
	const baseArgs = {
		model: {} as any,
		reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
		...poolArgs([obsA, obsB, critical], 20),
	};
	const recordTool = (context: any) => context.tools.find((tool: any) => tool.name === "record_reflections");
	const dropTool = (context: any) => context.tools.find((tool: any) => tool.name === "drop_observations");

	it("asks for reflections first, then drops, with the drop safety rules", async () => {
		let systemPrompt = "";
		let tools: string[] = [];
		const loop = fakeAgentLoop((_prompts, context) => {
			systemPrompt = context.messages[0]?.role === "system" ? context.messages[0].content : "";
			tools = context.tools.map((tool: any) => tool.name);
		});

		await runReflector({ ...baseArgs, agentLoop: loop });

		expect(tools).toEqual(["record_reflections", "drop_observations"]);
		expect(systemPrompt).toContain("1. Reflect: distill stable, long-lived facts");
		expect(systemPrompt).toContain("2. Drop: remove the safest active observations");
		expect(systemPrompt).toContain("Reflections are scarce, expensive durable orientation anchors");
		expect(systemPrompt).toContain("If unsure, emit no reflection");
		expect(systemPrompt).toContain("False or inflated support ids make unsafe drops look safe");
		expect(systemPrompt).toContain("Default action is KEEP");
		expect(systemPrompt).toContain("hard upper bound");
		expect(systemPrompt).toContain("Preservation floor");
		expect(systemPrompt).toContain("the newest one holds the current state: drop the older state, never the newer one");
		expect(systemPrompt).toContain("Never drop an observation that records an open task, a pending user decision, or work not yet done");
		expect(systemPrompt).toContain("Check reflections you recorded in this run as strictly as older ones");
		expect(systemPrompt).toContain("You cannot merge, rewrite, or edit observations");
	});

	it("shows coverage tiers, pool size, target, and the drop cap", async () => {
		let userText = "";
		const loop = fakeAgentLoop((prompts) => {
			userText = prompts[0].content[0].text;
		});

		await runReflector({ ...baseArgs, agentLoop: loop });

		expect(userText).toContain("[aaaaaaaaaaaa] 2026-05-02T10:00:00.000Z [medium] [coverage: partial] Observation aaaaaaaaaaaa");
		expect(userText).toContain("[bbbbbbbbbbbb] 2026-05-02T10:00:00.000Z [low] [coverage: none]");
		expect(userText).toContain("Active observation pool: ~56 tokens; target: ~20 tokens; fullness against target: ~280%; over target by ~36 tokens.");
		expect(userText).toContain("Maximum drops allowed this run: 2 observations. This maximum is a hard upper bound, not a target.");
	});

	it("renders reflector observation lines with coverage evidence only", () => {
		const line = observationToReflectorLine(
			observation("aaaaaaaaaaaa", { relevance: "critical", content: "Important reflected fact" }),
			"partial",
		);

		expect(line).toContain("[aaaaaaaaaaaa]");
		expect(line).toContain("[critical]");
		expect(line).toContain("[coverage: partial]");
		expect(line).toContain("Important reflected fact");
		expect(line).not.toContain("drop-priority");
	});

	it("summarizes accepted reflection support-id counts without exposing ids", () => {
		expect(summarizeSupportIdCounts([])).toEqual({
			reflectionCount: 0,
			totalSupportIds: 0,
			minSupportIds: 0,
			maxSupportIds: 0,
			averageSupportIds: 0,
			histogram: {},
		});
		expect(summarizeSupportIdCounts([
			reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa"]),
			reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]),
		])).toEqual({
			reflectionCount: 2,
			totalSupportIds: 4,
			minSupportIds: 1,
			maxSupportIds: 3,
			averageSupportIds: 2,
			histogram: { "1": 1, "3": 1 },
		});
	});

	it("normalizes supporting observation ids by active observation order", () => {
		expect(normalizeSupportingObservationIds(["bbbbbbbbbbbb", "aaaaaaaaaaaa", "aaaaaaaaaaaa"], ["aaaaaaaaaaaa", "bbbbbbbbbbbb"])).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(normalizeSupportingObservationIds(["aaaaaaaaaaaa", "missing"], ["aaaaaaaaaaaa"])).toBeUndefined();
		expect(normalizeSupportingObservationIds([], ["aaaaaaaaaaaa"])).toBeUndefined();
	});

	it("records one-line reflections with code-computed ids and token counts", async () => {
		const content = "User prefers source-backed memory.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await recordTool(context).execute("tool-1", {
				reflections: [{ content, supportingObservationIds: ["bbbbbbbbbbbb", "aaaaaaaaaaaa"] }],
			});
		});

		const result = await runReflector({ ...baseArgs, agentLoop: loop });

		expect(result).toEqual({
			reflections: [{ id: hashId(content), content, supportingObservationIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], tokenCount: estimateStringTokens(content) }],
			droppedObservationIds: [],
		});
	});

	it("rejects invented support ids and multiline content", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await recordTool(context).execute("tool-1", {
				reflections: [
					{ content: "Bad support", supportingObservationIds: ["missing"] },
					{ content: "Two\nlines", supportingObservationIds: ["aaaaaaaaaaaa"] },
				],
			});
		});

		await expect(runReflector({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("dedupes proposals and skips existing reflection ids", async () => {
		const content = "User prefers terse updates.";
		const existing = reflection(hashId(content), ["aaaaaaaaaaaa"], { content });
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await recordTool(context).execute("tool-1", {
				reflections: [
					{ content, supportingObservationIds: ["aaaaaaaaaaaa"] },
					{ content: "New durable fact.", supportingObservationIds: ["aaaaaaaaaaaa"] },
					{ content: "New durable fact.", supportingObservationIds: ["bbbbbbbbbbbb"] },
				],
			});
		});

		const result = await runReflector({ ...baseArgs, reflections: [existing], agentLoop: loop });

		expect(result?.reflections.map((item) => item.content)).toEqual(["New durable fact."]);
	});

	it("tells the model which observations its new reflections support", async () => {
		let receipt = "";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			const result = await recordTool(context).execute("tool-1", {
				reflections: [{ content: "User chose Postgres.", supportingObservationIds: ["bbbbbbbbbbbb", "aaaaaaaaaaaa"] }],
			});
			receipt = result.content[0].text;
		});

		await runReflector({ ...baseArgs, agentLoop: loop });

		expect(receipt).toContain("Observations these reflections now support: aaaaaaaaaaaa, bbbbbbbbbbbb.");
	});

	it("computes observation pool fullness defensively", () => {
		expect(observationPoolFullness(0, 100)).toBe(0);
		expect(observationPoolFullness(-1, 100)).toBe(0);
		expect(observationPoolFullness(10, 0)).toBe(0);
		expect(observationPoolFullness(10, Number.NaN)).toBe(0);
		expect(observationPoolFullness(25, 100)).toBe(0.25);
	});

	it("computes max drops from token excess above target", () => {
		const observations = Array.from({ length: 10 }, (_, index) =>
			observation(`${index}`.padStart(12, "a"), { relevance: "low", tokenCount: 10 }),
		);

		expect(maxDropCountForPool(observations, 100, 100)).toBe(0);
		expect(maxDropCountForPool(observations, 100, 90)).toBe(1);
		expect(maxDropCountForPool(observations, 100, 50)).toBe(5);
		expect(maxDropCountForPool(observations, 100, 0)).toBe(10);
	});

	it("selects final drops by coverage, lower relevance, age, then stable ordering", () => {
		const highA = observation("aaaaaaaaaaaa", { relevance: "high" });
		const lowA = observation("bbbbbbbbbbbb", { relevance: "low" });
		const medium = observation("dddddddddddd", { relevance: "medium" });
		const lowB = observation("eeeeeeeeeeee", { relevance: "low" });
		const highB = observation("ffffffffffff", { relevance: "high" });
		const criticalObs = observation("111111111111", { relevance: "critical" });
		const observations = [highA, lowA, medium, lowB, highB, criticalObs];

		expect(selectDropCandidates([
			"aaaaaaaaaaaa",
			"missing",
			"111111111111",
			"bbbbbbbbbbbb",
			"dddddddddddd",
			"bbbbbbbbbbbb",
			"eeeeeeeeeeee",
			"ffffffffffff",
		], observations, 3)).toEqual(["bbbbbbbbbbbb", "eeeeeeeeeeee", "dddddddddddd"]);

		const oldHigh = observation("999999999999", { relevance: "high", timestamp: "2026-01-01T00:00:00.000Z" });
		const newHigh = observation("888888888888", { relevance: "high", timestamp: "2026-02-01T00:00:00.000Z" });
		expect(selectDropCandidates(["888888888888", "999999999999"], [oldHigh, newHigh], 1)).toEqual(["999999999999"]);
	});

	it("prefers stronger reflection coverage before relevance when over cap", () => {
		const strongCritical = observation("aaaaaaaaaaaa", { relevance: "critical", timestamp: "2026-01-01T00:00:00.000Z" });
		const partialLow = observation("bbbbbbbbbbbb", { relevance: "low", timestamp: "2026-01-01T00:00:00.000Z" });
		const noneLow = observation("cccccccccccc", { relevance: "low", timestamp: "2026-01-01T00:00:00.000Z" });
		const reflections = [
			reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]),
			reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa"]),
		];

		expect(selectDropCandidates(["cccccccccccc", "bbbbbbbbbbbb", "aaaaaaaaaaaa"], [strongCritical, partialLow, noneLow], 2, reflections)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
	});

	it("caps drops at maxDropsAllowed across repeated calls and ignores unknown ids", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await dropTool(context).execute("tool-1", { ids: ["aaaaaaaaaaaa", "missing"] });
			await dropTool(context).execute("tool-2", { ids: ["bbbbbbbbbbbb", "aaaaaaaaaaaa"] });
		});

		// A 40-token target leaves 16 tokens over: one drop at most.
		const result = await runReflector({ ...baseArgs, ...poolArgs([obsA, obsB, critical], 40), agentLoop: loop });

		// obsA has partial coverage from the existing reflection, so it goes before the uncovered obsB.
		expect(result).toEqual({ reflections: [], droppedObservationIds: ["aaaaaaaaaaaa"] });
	});

	it("counts reflections recorded in the same pass as coverage when choosing drops", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await recordTool(context).execute("tool-1", {
				reflections: [{ content: "Low detail is durable.", supportingObservationIds: ["bbbbbbbbbbbb"] }],
			});
			await recordTool(context).execute("tool-2", {
				reflections: [{ content: "Low detail matters twice.", supportingObservationIds: ["bbbbbbbbbbbb"] }],
			});
			await dropTool(context).execute("tool-3", { ids: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"] });
		});

		const result = await runReflector({ ...baseArgs, ...poolArgs([obsA, obsB, critical], 40), agentLoop: loop });

		// obsB is now strongly covered by two new reflections; obsA only partially by the old one.
		expect(result?.droppedObservationIds).toEqual(["bbbbbbbbbbbb"]);
	});

	it("only reflects, with no drop tool or drop rules, when the pool is at or below its target", async () => {
		let seen: { tools: string[]; system: string; user: string } | undefined;
		const loop = fakeAgentLoop(async (prompts, context) => {
			seen = { tools: context.tools.map((tool: any) => tool.name), system: context.messages[0].content, user: prompts[0].content[0].text };
			await recordTool(context).execute("tool-1", { reflections: [{ content: "User prefers source-backed memory.", supportingObservationIds: ["aaaaaaaaaaaa"] }] });
		});

		const result = await runReflector({ ...baseArgs, ...poolArgs([obsA, obsB, critical], 56), agentLoop: loop });

		expect(seen?.tools).toEqual(["record_reflections"]);
		expect(seen?.system).toContain("The active observation pool is within its target, so this run drops nothing.");
		expect(seen?.system).toContain("If unsure, emit no reflection");
		expect(seen?.system).not.toContain("drop_observations");
		expect(seen?.system).not.toContain("Default action is KEEP");
		expect(seen?.user).toContain("Crystallize any missing durable facts or patterns into new reflections.");
		expect(seen?.user).not.toContain("Maximum drops allowed");
		expect(result?.droppedObservationIds).toEqual([]);
		expect(result?.reflections.map((r) => r.content)).toEqual(["User prefers source-backed memory."]);
	});

	it("returns undefined when no tool call changes memory", async () => {
		const loop = fakeAgentLoop(() => {});
		await expect(runReflector({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("throws on a failed stream that changed nothing", async () => {
		for (const stopReason of ["error", "aborted"]) {
			const loop = (() => ({
				async *[Symbol.asyncIterator]() {
					yield { type: "message_end", message: { role: "assistant", stopReason, errorMessage: "rate limited" } };
				},
				result: async () => ({}),
			})) as any;
			await expect(runReflector({ ...baseArgs, agentLoop: loop })).rejects.toMatchObject({
				name: "ReflectorStreamError", stopReason, message: expect.stringContaining("rate limited"),
			});
		}
	});

	it("keeps accepted reflections and drops when a later stream turn fails", async () => {
		const content = "User prefers source-backed memory.";
		const loop = ((_prompts: any[], context: any) => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "message_end", message: { role: "assistant", stopReason: "toolUse" } };
				await recordTool(context).execute("tool-1", { reflections: [{ content, supportingObservationIds: ["aaaaaaaaaaaa"] }] });
				await dropTool(context).execute("tool-2", { ids: ["aaaaaaaaaaaa"] });
				yield { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "rate limited" } };
			},
			result: async () => ({}),
		})) as any;
		await expect(runReflector({ ...baseArgs, agentLoop: loop })).resolves.toMatchObject({
			reflections: [{ content }],
			droppedObservationIds: ["aaaaaaaaaaaa"],
		});
	});
});
