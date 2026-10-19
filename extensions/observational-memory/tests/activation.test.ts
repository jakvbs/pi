import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({ runObserver: vi.fn() }));

vi.mock("../src/agents/observer/agent.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.ts")>()),
	runObserver: mockAgents.runObserver,
}));

import { registerActivation } from "../src/hooks/activation.ts";
import { OM_OBSERVATIONS_RECORDED } from "../src/session-ledger/index.ts";
import { compactionEntry, observation, observationsRecordedEntry, rawMessage, type TestEntry } from "./fixtures/session.ts";

/** Every message carries 400 characters, which Pi estimates as 100 tokens. */
const TEXT = "x".repeat(400);

function userMessage(id: string): TestEntry {
	return rawMessage(id, TEXT);
}

function assistantMessage(id: string): TestEntry {
	return rawMessage(id, TEXT, {
		message: { role: "assistant", content: [{ type: "text", text: TEXT }], stopReason: "end_turn" },
	});
}

function toolResultMessage(id: string): TestEntry {
	return rawMessage(id, TEXT, {
		message: { role: "toolResult", toolCallId: `call-${id}`, toolName: "bash", content: [{ type: "text", text: TEXT }] },
	});
}

function coverage(id: string, coversUpToId: string, observationId: string): TestEntry {
	return observationsRecordedEntry(id, {
		observations: [observation(observationId, { sourceEntryIds: [coversUpToId], tokenCount: 10 })],
		coversUpToId,
	});
}

/** 0 u0  1 a0  2 u1  3 a1  4 t1  5 a2: six source entries, ~600 tokens. */
function conversation(): TestEntry[] {
	return [
		userMessage("u0"),
		assistantMessage("a0"),
		userMessage("u1"),
		assistantMessage("a1"),
		toolResultMessage("t1"),
		assistantMessage("a2"),
	];
}

function setup(args: {
	entries: TestEntry[];
	compactAfterTokens: number;
	passive?: boolean;
	consolidationPromise?: Promise<void>;
}) {
	let entries = [...args.entries];
	let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const pi = {
		on: vi.fn((eventName: string, cb: typeof handler) => {
			expect(eventName).toBe("turn_end");
			handler = cb;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries = [...entries, {
				type: "custom",
				id: `appended-${pi.appendEntry.mock.calls.length}`,
				parentId: null,
				timestamp: "2026-05-02T10:00:00.000Z",
				customType,
				data,
			}];
		}),
	};
	const runtime = {
		config: {
			compactAfterTokens: args.compactAfterTokens,
			compactAfterTokensMode: "calibrated",
			observationsPoolMaxTokens: 20_000,
			compactionSummaryMaxTokens: 8_000,
			compactionCatchUpMaxChunks: 2,
			agentMaxTurns: 4,
			agentMaxTokens: 8192,
			showWorkerNotifications: true,
			passive: args.passive ?? false,
			model: { provider: "gtr7", id: "memory", thinking: "off" },
		},
		consolidationInFlight: false,
		consolidationPromise: args.consolidationPromise ?? null,
		resolveModel: vi.fn(async () => ({ ok: true, model: { provider: "gtr7", id: "memory", contextWindow: 65536 }, apiKey: "key" })),
		ensureConfig: vi.fn(),
	};
	registerActivation(pi as any, runtime as any);
	if (!handler) throw new Error("activation handler was not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { contextWindow: 200_000 },
		modelRegistry: {},
		signal: undefined,
		sessionManager: { getBranch: vi.fn(() => entries) },
	};
	const run = (event: { outcome?: string; entries?: unknown[] } = {}) => handler!({
		type: "turn_end",
		outcome: event.outcome ?? "completed",
		entries: event.entries ?? [],
		continue: false,
	}, ctx) as Promise<any>;
	return {
		pi,
		runtime,
		ctx,
		run,
		pushEntry: (entry: TestEntry) => {
			entries = [...entries, entry];
		},
	};
}

beforeEach(() => {
	mockAgents.runObserver.mockReset();
});

describe("turn_end memory activation", () => {
	it("folds observed history into a compaction entry and keeps the newest ~20% of the threshold raw", async () => {
		const { run, ctx } = setup({
			entries: [...conversation(), userMessage("u2"), assistantMessage("a3"), coverage("om-a3", "a3", "aaaaaaaaaaaa")],
			compactAfterTokens: 750,
		});

		const result = await run();

		expect(result.entries).toHaveLength(1);
		const [draft] = result.entries;
		expect(draft.type).toBe("compaction");
		expect(draft.firstKeptEntryId).toBe("u2");
		// The only observer chunk straddles the cut, so it is folded whole.
		expect(draft.details.foldThroughEntryId).toBe("a3");
		expect(draft.summary).toContain("[aaaaaaaaaaaa] 2026-05-02T10:00:00.000Z [medium] Observation aaaaaaaaaaaa");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: activated memory over ~600 source tokens; ~200 kept as history",
			"info",
		);
	});

	it("does nothing while the history since the compaction boundary is below the threshold", async () => {
		const entries = [
			...conversation(),
			coverage("om-a2", "a2", "aaaaaaaaaaaa"),
			compactionEntry("cmp", { firstKeptEntryId: "a1" }),
		];
		const { run } = setup({ entries, compactAfterTokens: 500 });

		expect(await run()).toBeUndefined();
	});

	it("cuts no later than the observer frontier and folds through the coverage marker", async () => {
		const { run, runtime } = setup({
			entries: [...conversation(), coverage("om-a0", "a0", "aaaaaaaaaaaa")],
			compactAfterTokens: 500,
		});

		const [draft] = (await run()).entries;

		expect(draft.firstKeptEntryId).toBe("u1");
		expect(draft.details.foldThroughEntryId).toBe("a0");
		expect(draft.details.observations.map((obs: any) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(runtime.resolveModel).not.toHaveBeenCalled();
	});

	it("keeps a tool result with the assistant message that called it", async () => {
		const { run } = setup({
			entries: [...conversation(), coverage("om-a1", "a1", "aaaaaaaaaaaa")],
			compactAfterTokens: 500,
		});

		const [draft] = (await run()).entries;

		expect(draft.firstKeptEntryId).toBe("a1");
		expect(draft.details.foldThroughEntryId).toBe("a1");
	});

	it("waits for the background observer while nothing is observed and the tail is below blockAfter", async () => {
		const { run, runtime, pi } = setup({ entries: conversation(), compactAfterTokens: 550 });

		expect(await run()).toBeUndefined();
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("observes the gap synchronously once the retained tail reaches blockAfter, then activates", async () => {
		const gapObs = observation("bbbbbbbbbbbb", { sourceEntryIds: ["u0", "a0", "u1", "a1", "t1"], tokenCount: 12 });
		mockAgents.runObserver.mockResolvedValueOnce([gapObs]);
		const { run, pi } = setup({ entries: conversation(), compactAfterTokens: 500 });

		const [draft] = (await run()).entries;

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			allowedSourceEntryIds: ["u0", "a0", "u1", "a1", "t1"],
		}));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [gapObs], coversUpToId: "t1" });
		expect(draft.firstKeptEntryId).toBe("a2");
		expect(draft.details.observations.map((obs: any) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
	});

	it("waits for an in-flight consolidation run before observing synchronously", async () => {
		let setup_: ReturnType<typeof setup> | undefined;
		const consolidationPromise = Promise.resolve().then(() => {
			setup_!.pushEntry(coverage("om-a2", "a2", "cccccccccccc"));
		});
		setup_ = setup({ entries: conversation(), compactAfterTokens: 500, consolidationPromise });

		const [draft] = (await setup_.run()).entries;

		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(draft.firstKeptEntryId).toBe("a2");
		expect(draft.details.observations.map((obs: any) => obs.id)).toEqual(["cccccccccccc"]);
	});

	it("appends after entries proposed by earlier turn_end handlers", async () => {
		const earlier = { type: "custom", customType: "other", data: {} };
		const { run } = setup({ entries: [...conversation(), coverage("om-a2", "a2", "aaaaaaaaaaaa")], compactAfterTokens: 500 });

		const result = await run({ entries: [earlier] });

		expect(result.entries.map((entry: any) => entry.type)).toEqual(["custom", "compaction"]);
		expect(result.entries[0]).toBe(earlier);
	});

	it("leaves the turn alone when another handler already proposed a compaction, the turn failed, or memory is passive", async () => {
		const entries = [...conversation(), coverage("om-a2", "a2", "aaaaaaaaaaaa")];

		expect(await setup({ entries, compactAfterTokens: 500 }).run({ entries: [{ type: "compaction", summary: "s", firstKeptEntryId: "a2" }] })).toBeUndefined();
		expect(await setup({ entries, compactAfterTokens: 500 }).run({ outcome: "aborted" })).toBeUndefined();
		expect(await setup({ entries, compactAfterTokens: 500, passive: true }).run()).toBeUndefined();
	});
});
