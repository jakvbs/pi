import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({
	runObserver: vi.fn(),
	runReflector: vi.fn(),
}));

vi.mock("../src/agents/observer/agent.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.ts")>()),
	runObserver: mockAgents.runObserver,
}));
vi.mock("../src/agents/reflector/agent.ts", () => ({ runReflector: mockAgents.runReflector }));

import { ObserverStreamError } from "../src/agents/observer/agent.ts";
import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.ts";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
} from "../src/session-ledger/index.ts";
import {
	compactionEntry,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	rawMessage,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.ts";
import { Warnings } from "../src/warnings.ts";

beforeEach(() => {
	mockAgents.runObserver.mockReset();
	mockAgents.runReflector.mockReset();
	mockAgents.runObserver.mockResolvedValue(undefined);
	mockAgents.runReflector.mockResolvedValue(undefined);
});

function setup(args: {
	entries: TestEntry[];
	observeAfterTokens?: number;
	reflectAfterTokens?: number;
	observerChunkMaxTokens?: number;
	observationsPoolMaxTokens?: number;
	observationsPoolTargetTokens?: number;
	workerMemoryMaxTokens?: number;
	showWorkerNotifications?: boolean;
	passive?: boolean;
	consolidationInFlight?: boolean;
	appendEntryReturnsId?: boolean;
	sessionId?: string;
	consolidateWhenIdle?: boolean;
}) {
	let entries = [...args.entries];
	let sessionId = args.sessionId ?? "session-1";
	const handlers: Record<string, ((event: unknown, ctx: any) => void) | undefined> = {};
	const pi = {
		on: vi.fn((eventName: string, cb: (event: unknown, ctx: any) => void) => {
			handlers[eventName] = cb;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			const id = `appended-${pi.appendEntry.mock.calls.length}`;
			entries = [...entries, { type: "custom", id, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-05-02T10:00:00.000Z", customType, data }];
			return args.appendEntryReturnsId === false ? undefined : id;
		}),
	};
	let launchedWork: (() => Promise<void>) | undefined;
	let resolveLaunched: (() => void) | undefined;
	const runtime = {
		config: {
			showWorkerNotifications: args.showWorkerNotifications ?? true,
			passive: args.passive ?? false,
			consolidateWhenIdle: args.consolidateWhenIdle ?? false,
			debugLog: false,
			observeAfterTokens: args.observeAfterTokens ?? 1,
			reflectAfterTokens: args.reflectAfterTokens ?? 999,
			observerChunkMaxTokens: args.observerChunkMaxTokens,
			workerMemoryMaxTokens: args.workerMemoryMaxTokens,
			observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 100,
			observationsPoolTargetTokens: args.observationsPoolTargetTokens ?? Math.floor((args.observationsPoolMaxTokens ?? 100) / 2),
			agentMaxTurns: 9,
			agentMaxTokens: 32000,
			model: { provider: "anthropic", id: "memory", thinking: "minimal" },
		},
		consolidationInFlight: args.consolidationInFlight ?? false,
		consolidationAbortController: undefined as AbortController | undefined,
		abortConsolidation: vi.fn(() => {
			if (!runtime.consolidationInFlight || !runtime.consolidationAbortController) return false;
			runtime.consolidationAbortController.abort();
			return true;
		}),
		consolidationPhase: undefined as "observer" | "reflector" | undefined,
		warnings: new Warnings(),
		lastObserverError: undefined as string | undefined,
		lastReflectorError: undefined as string | undefined,
		reflectorEmptyBackoff: undefined as { sessionIdentity: string | undefined; passMarkerId: string | undefined; tokensAtEmpty: number } | undefined,
		ensureConfig: vi.fn(),
		resolveModel: vi.fn(() => ({ ok: true, model: { reasoning: true } })),
		resolveFallbackModel: vi.fn(() => ({ ok: false, reason: "no fallback model configured" })),
		launchConsolidationTask: vi.fn((_ctx, work) => {
			runtime.consolidationInFlight = true;
			runtime.consolidationAbortController = new AbortController();
			launchedWork = work;
			// Resolve when the test drives the work via runLaunchedWork().
			return new Promise<void>((resolve) => {
				resolveLaunched = () => {
					runtime.consolidationInFlight = false;
					resolve();
				};
			});
		}),
		recordConsolidationStageError: vi.fn((ctx, phase: "observer" | "reflector", error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (phase === "observer") runtime.lastObserverError = message;
			if (phase === "reflector") runtime.lastReflectorError = message;
			ctx.ui?.notify(`Observational memory: ${phase} failed: ${message}`, "warning");
			return message;
		}),
	};
	registerConsolidationTrigger(pi as any, runtime as any);
	if (!handlers.agent_start) throw new Error("agent_start consolidation handler not registered");
	if (!handlers.turn_end) throw new Error("turn_end consolidation handler not registered");
	if (!handlers.agent_settled) throw new Error("agent_settled consolidation handler not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { provider: "session" },
		modelRegistry: { find: vi.fn(() => undefined), streamSimple: vi.fn() },
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => sessionId,
		},
	};
	return {
		pi,
		runtime,
		ctx,
		fire: (eventName = "turn_end") => handlers[eventName]!(undefined, ctx),
		fireAgentStart: () => handlers.agent_start!(undefined, ctx),
		fireTurnEnd: () => handlers.turn_end!(undefined, ctx),
		runLaunchedWork: async () => {
			try {
				await launchedWork?.();
			} finally {
				resolveLaunched?.();
			}
		},
		fireAgentSettled: () => handlers.agent_settled!(undefined, ctx),
		addEntries: (...more: TestEntry[]) => {
			entries = [...entries, ...more];
		},
		setSessionId: (next: string) => {
			sessionId = next;
		},
		/** Move to another branch, as `/tree` or editing an earlier message does. */
		navigate: (branch: TestEntry[]) => {
			entries = [...branch];
		},
		getEntries: () => entries,
	};
}

describe("V3 consolidation trigger", () => {
	const obsA = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
	const obsB = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"], tokenCount: 10 });
	const refA = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

	it("registers agent_start and turn_end consolidation entrypoints", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { pi } = setup({ entries });

		expect(pi.on).toHaveBeenCalledWith("agent_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
	});

	it("does not launch below all thresholds from either entrypoint", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }),
		];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries, observeAfterTokens: 10 });

		fireAgentStart();
		fireTurnEnd();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("does not launch from either entrypoint in passive mode", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const passive = setup({ entries, passive: true });

		passive.fireAgentStart();
		passive.fireTurnEnd();

		expect(passive.runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("does not launch from either entrypoint while consolidation is already in flight", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const locked = setup({ entries, consolidationInFlight: true });

		locked.fireAgentStart();
		locked.fireTurnEnd();

		expect(locked.runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("launches on a due raw backlog even when provider growth since the last compaction is below the threshold", () => {
		// Coverage stops before the latest compaction, so the provider delta is
		// measured from the post-compaction baseline (1000 -> 1000 = 0 growth)
		// while the uncovered raw backlog is far above observeAfterTokens.
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
			compactionEntry("cmp-1", { firstKeptEntryId: "assistant-1" }),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 1000 } },
			}),
			textCustomMessage("raw-3", "cccc"),
		];
		const { fireTurnEnd, runtime, ctx } = setup({ entries, observeAfterTokens: 5 });
		(ctx as any).getContextUsage = () => ({ tokens: 1000, contextWindow: 65536 });

		fireTurnEnd();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("does not launch when both the raw backlog and provider growth are below the threshold", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			compactionEntry("cmp-1", { firstKeptEntryId: "assistant-1" }),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 1000 } },
			}),
			textCustomMessage("raw-2", "bbbb"),
		];
		const { fireTurnEnd, runtime, ctx } = setup({ entries, observeAfterTokens: 5 });
		(ctx as any).getContextUsage = () => ({ tokens: 1002, contextWindow: 65536 });

		fireTurnEnd();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("launches from agent_start when work is due", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, runtime } = setup({ entries });

		fireAgentStart();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("uses the shared lock when agent_start fires before turn_end", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries });

		fireAgentStart();
		fireTurnEnd();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("uses the shared lock when turn_end fires before agent_start", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries });

		fireTurnEnd();
		fireAgentStart();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("runs observer first and appends source-addressed observations", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(runtime.launchConsolidationTask).toHaveBeenCalled();
		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			allowedSourceEntryIds: ["raw-1"],
			maxTurns: 9,
			thinkingLevel: "minimal",
		}));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obs], coversUpToId: "raw-1" });
	});

	// Real shape from a 2026-10-18 session: the observer read a branch ending at
	// `6fe29b75`, the user went back to its parent `54e12a5b`, and the
	// observations landed on the new branch with a coverage marker not on it.
	it("drops a worker result when the user moved to another branch while it ran", async () => {
		const shared = textCustomMessage("54e12a5b", "aaaaaaaa");
		const abandoned = textCustomMessage("6fe29b75", "bbbbbbbb");
		const obs = observation("cccccccccccc", { sourceEntryIds: ["54e12a5b", "6fe29b75"], tokenCount: 4 });
		const { fire, runLaunchedWork, pi, navigate } = setup({ entries: [shared, abandoned] });
		mockAgents.runObserver.mockImplementationOnce(async () => {
			navigate([shared, textCustomMessage("retry-1", "cccccccc")]);
			return [obs];
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ allowedSourceEntryIds: ["54e12a5b", "6fe29b75"] }));
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
	});

	it("uses existing observation coverage and retries larger ranges after no-output", async () => {
		const prior = observation("cccccccccccc", { sourceEntryIds: ["raw-1"] });
		const newObs = observation("dddddddddddd", { sourceEntryIds: ["raw-2"] });
		mockAgents.runObserver.mockResolvedValueOnce([newObs]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-prior", { observations: [prior], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			textCustomMessage("raw-3", "cccccccc"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ allowedSourceEntryIds: ["raw-2", "raw-3"] }));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [newObs], coversUpToId: "raw-3" });
	});

	it("observer no-output appends nothing and does not fake observation coverage", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
	});

	it("shows routine worker notifications by default", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		mockAgents.runReflector.mockResolvedValueOnce({ reflections: [newRef], droppedObservationIds: ["aaaaaaaaaaaa"] });
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, ctx } = setup({ entries, observationsPoolMaxTokens: 10, observationsPoolTargetTokens: 5 });

		fire();
		await runLaunchedWork();

		expect(ctx.ui.notify.mock.calls).toEqual([
			[expect.stringMatching(/^Observational memory: observer running on ~\d+-token chunk$/), "info"],
			["Observational memory: observer +1 observation\n  • Observation aaaaaaaaaaaa", "info"],
			["Observational memory: reflector running (~2 tokens) — active observation pool ~19 / 5 target tokens", "info"],
			["Observational memory: reflector +1 reflection\n  • Reflection ffffffffffff", "info"],
			["Observational memory: reflector −1 observation\n  • Observation aaaaaaaaaaaa", "info"],
		]);
	});

	it("suppresses routine worker notifications without hiding warnings", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		mockAgents.runReflector.mockResolvedValueOnce({ reflections: [newRef], droppedObservationIds: ["aaaaaaaaaaaa"] });
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const quiet = setup({ entries, observationsPoolMaxTokens: 10, observationsPoolTargetTokens: 5, showWorkerNotifications: false });

		quiet.fire();
		await quiet.runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledOnce();
		expect(mockAgents.runReflector).toHaveBeenCalledOnce();
		expect(quiet.pi.appendEntry).toHaveBeenCalledTimes(3);
		expect(quiet.ctx.ui.notify).not.toHaveBeenCalled();

		// Deliberate empty is routine info: also hidden when quiet.
		mockAgents.runObserver.mockReset();
		mockAgents.runObserver.mockResolvedValueOnce(undefined);
		const noOutput = setup({ entries, showWorkerNotifications: false });

		noOutput.fire();
		await noOutput.runLaunchedWork();

		expect(noOutput.ctx.ui.notify).not.toHaveBeenCalled();

		// Real failures still surface as warnings when quiet.
		mockAgents.runObserver.mockReset();
		mockAgents.runObserver.mockRejectedValueOnce(new ObserverStreamError("error", "prompt is too long"));
		const failed = setup({ entries, showWorkerNotifications: false });

		failed.fire();
		await failed.runLaunchedWork();

		expect(failed.ctx.ui.notify).toHaveBeenCalledOnce();
		expect(failed.ctx.ui.notify.mock.calls[0][1]).toBe("warning");
		expect(failed.ctx.ui.notify.mock.calls[0][0]).toContain("observer failed");
	});

	it("reports deliberate empty as info, not a warning", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, ctx } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(ctx.ui.notify.mock.calls).toEqual([
			[expect.stringMatching(/^Observational memory: observer running on ~\d+-token chunk$/), "info"],
			["Observational memory: observer found nothing new in this chunk (coverage unchanged; will retry later)", "info"],
		]);
	});

	it("backs off observer re-fires after a deliberate empty until enough new tokens arrive", async () => {
		const entries = [textCustomMessage("raw-1", "a".repeat(40))]; // 10 tokens
		const { fire, runLaunchedWork, addEntries, runtime } = setup({ entries, observeAfterTokens: 10 });

		fire();
		await runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(runtime.observerEmptyBackoff).toEqual({
			sessionIdentity: "session-1",
			coverageId: undefined,
			tokensAtEmpty: 10,
		});

		// Same span, only 5 new tokens (< observeAfterTokens more): no re-fire.
		addEntries(textCustomMessage("raw-2", "b".repeat(20)));
		runtime.consolidationInFlight = false;
		fire();
		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(2);
		await runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);

		// 10 more new tokens: backoff satisfied, observer re-fires over the grown span.
		addEntries(textCustomMessage("raw-3", "c".repeat(40)));
		runtime.consolidationInFlight = false;
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		fire();
		await runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
		expect(runtime.observerEmptyBackoff).toBeUndefined();
	});

	it("does not apply deliberate-empty backoff to another session", async () => {
		const entries = [textCustomMessage("raw-1", "a".repeat(40))];
		const { fire, runLaunchedWork, runtime, setSessionId } = setup({
			entries,
			observeAfterTokens: 10,
		});

		fire();
		await runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);

		runtime.consolidationInFlight = false;
		setSessionId("session-2");
		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
	});

	it("surfaces API stream errors as observer failure, never as empty", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(new ObserverStreamError("error", "prompt is too long: 5198507 tokens > 1000000 maximum"));
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(runtime.lastObserverError).toContain("prompt is too long");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'Observational memory: observer failed: observer stream ended with stopReason "error": prompt is too long: 5198507 tokens > 1000000 maximum',
			"warning",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("no observations"), expect.anything());
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.observerEmptyBackoff).toBeUndefined();
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
	});


	it("model resolution failure skips appending and notifies once", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries });
		runtime.resolveModel.mockReturnValueOnce({ ok: false, reason: "no model" });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("Observational memory: observer skipped — no model", "warning");
	});

	it("re-reads branch so observer append can unblock reflector in the same consolidation run", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce({ reflections: [newRef], droppedObservationIds: [] });
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi } = setup({ entries, observationsPoolMaxTokens: 10 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ observations: [obsA] }));
		expect(mockAgents.runObserver.mock.invocationCallOrder[0]).toBeLessThan(mockAgents.runReflector.mock.invocationCallOrder[0]);
		expect(pi.appendEntry.mock.calls).toEqual([
			[OM_OBSERVATIONS_RECORDED, { observations: [obsA], coversUpToId: "raw-1" }],
			[OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" }],
		]);
	});

	it("runs the reflector once the active pool reaches observationsPoolMaxTokens and records reflections, then drops", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce({ reflections: [newRef], droppedObservationIds: ["aaaaaaaaaaaa"] });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		// Two rendered observation lines of 19 tokens each: 38 tokens reach a 38-token limit.
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 38, observationsPoolTargetTokens: 19 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({
			observations: [obsA, obsB],
			pool: expect.objectContaining({ observationTokens: 38, targetTokens: 19, maxDropsAllowed: 1 }),
			maxTurns: 9,
			thinkingLevel: "minimal",
		}));
		expect(pi.appendEntry.mock.calls).toEqual([
			[OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-2" }],
			[OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }],
		]);
	});

	it("records drops alone when the pass adds no reflection", async () => {
		mockAgents.runReflector.mockResolvedValueOnce({ reflections: [], droppedObservationIds: ["aaaaaaaaaaaa"] });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 10 });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry.mock.calls).toEqual([[OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }]]);
	});

	it("does not launch the reflector below reflectAfterTokens and observationsPoolMaxTokens", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
		];
		const { fire, runtime } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 20 });

		fire();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("counts only active observations toward the reflector limit", () => {
		const heavy = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], content: "x".repeat(400) });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-heavy", { observations: [heavy], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["cccccccccccc"], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runtime } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 100 });

		fire();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("waits for new observations after a pass that left the pool over its limit", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA, obsB], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
		];
		const { fire, runtime, addEntries } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 10 });

		fire();
		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();

		addEntries(textCustomMessage("raw-2", "cccccccc"), observationsRecordedEntry("om-obs-c", { observations: [observation("cccccccccccc", { sourceEntryIds: ["raw-2"] })], coversUpToId: "raw-2" }));
		fire();
		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("runs the reflector every reflectAfterTokens of observed source and only reflects while the pool is within its target", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce({ reflections: [newRef], droppedObservationIds: [] });
		const entries = [
			textCustomMessage("raw-1", "a".repeat(40)), // 10 tokens
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, reflectAfterTokens: 10, observationsPoolMaxTokens: 100, observationsPoolTargetTokens: 50 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({
			observations: [obsA],
			pool: expect.objectContaining({ observationTokens: 19, targetTokens: 50, maxDropsAllowed: 0 }),
		}));
		expect(pi.appendEntry.mock.calls).toEqual([[OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" }]]);
	});

	it("counts observed source from the latest reflector pass, also one that only dropped", () => {
		const entries = [
			textCustomMessage("raw-1", "a".repeat(40)),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "b".repeat(16)), // 4 tokens
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runtime, addEntries } = setup({ entries, observeAfterTokens: 999, reflectAfterTokens: 5 });

		fire();
		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();

		addEntries(textCustomMessage("raw-3", "c".repeat(16)), observationsRecordedEntry("om-obs-c", { observations: [observation("cccccccccccc", { sourceEntryIds: ["raw-3"] })], coversUpToId: "raw-3" }));
		fire();
		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("backs off after a pass that changed nothing until another reflectAfterTokens arrives, in that session only", async () => {
		const entries = [
			textCustomMessage("raw-1", "a".repeat(40)), // 10 tokens
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
		];
		const { fire, runLaunchedWork, runtime, addEntries, setSessionId, pi } = setup({ entries, observeAfterTokens: 999, reflectAfterTokens: 10 });

		fire();
		await runLaunchedWork();
		expect(mockAgents.runReflector).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.reflectorEmptyBackoff).toEqual({ sessionIdentity: "session-1", passMarkerId: undefined, tokensAtEmpty: 10 });

		addEntries(textCustomMessage("raw-2", "b".repeat(16)), observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }));
		fire();
		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);

		setSessionId("session-2");
		fire();
		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(2);
		await runLaunchedWork();

		setSessionId("session-1");
		runtime.reflectorEmptyBackoff = { sessionIdentity: "session-1", passMarkerId: undefined, tokensAtEmpty: 10 };
		addEntries(textCustomMessage("raw-3", "c".repeat(24)), observationsRecordedEntry("om-obs-c", { observations: [observation("cccccccccccc", { sourceEntryIds: ["raw-3"] })], coversUpToId: "raw-3" }));
		fire();
		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(3);
	});

	it("does not run the reflector without observation coverage", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 1 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("preserves stage failure boundaries", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(new Error("observe failed"));
		const observerFailure = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], observationsPoolMaxTokens: 1 });
		observerFailure.fire();
		await observerFailure.runLaunchedWork();
		expect(observerFailure.runtime.lastObserverError).toBe("observe failed");
		expect(mockAgents.runReflector).not.toHaveBeenCalled();

		mockAgents.runReflector.mockRejectedValueOnce(new Error("reflect failed"));
		const reflectorFailure = setup({
			entries: [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" })],
			observeAfterTokens: 999,
			observationsPoolMaxTokens: 10,
		});
		reflectorFailure.fire();
		await reflectorFailure.runLaunchedWork();
		expect(reflectorFailure.runtime.lastReflectorError).toBe("reflect failed");
		expect(reflectorFailure.runtime.reflectorEmptyBackoff).toBeUndefined();
		expect(reflectorFailure.pi.appendEntry).not.toHaveBeenCalled();
	});

	describe("fallback model retry", () => {
		it("uses the resolution-level fallback model for the observer", async () => {
			const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
			mockAgents.runObserver.mockResolvedValueOnce([obs]);
			const { fire, runLaunchedWork, pi, runtime } = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
			(runtime.config as any).fallbackModel = { provider: "opencode-go", id: "deepseek-v4.1-flash", thinking: "high" };
			const fallback = { provider: "opencode-go", id: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/zen/go/v1" };
			runtime.resolveModel.mockReturnValueOnce({
				ok: true,
				model: fallback,
				fallbackUsed: true,
				primaryFailure: "primary unavailable",
			});

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenCalledOnce();
			expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
				model: fallback,
				thinkingLevel: "high",
			}));
			expect(runtime.resolveFallbackModel).not.toHaveBeenCalled();
			expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obs], coversUpToId: "raw-1" });
		});

		it("retries the observer once with the fallback model after a primary stream error", async () => {
			const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
			mockAgents.runObserver
				.mockRejectedValueOnce(new ObserverStreamError("error", "primary down"))
				.mockResolvedValueOnce([obs]);
			const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
			const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries });
			runtime.resolveFallbackModel.mockReturnValueOnce({
				ok: true,
				model: { provider: "opencode-go", id: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/zen/go/v1" },
			});

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
			expect(mockAgents.runObserver).toHaveBeenNthCalledWith(2, expect.objectContaining({
				model: { provider: "opencode-go", id: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/zen/go/v1" },
			}));
			expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obs], coversUpToId: "raw-1" });
			expect(runtime.lastObserverError).toBeUndefined();
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("retrying with fallback model"),
				"warning",
			);
		});

		it("reuses the fallback model for later stages in the same pass", async () => {
			const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
			const ref = reflection("ffffffffffff", ["cccccccccccc"]);
			mockAgents.runObserver
				.mockRejectedValueOnce(new ObserverStreamError("error", "primary down"))
				.mockResolvedValueOnce([obs]);
			mockAgents.runReflector.mockResolvedValueOnce({ reflections: [ref], droppedObservationIds: [] });
			const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
			const { fire, runLaunchedWork, runtime } = setup({ entries, observationsPoolMaxTokens: 10 });
			runtime.resolveFallbackModel.mockReturnValueOnce({
				ok: true,
				model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
			});

			fire();
			await runLaunchedWork();

			expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: "opencode-go", id: "deepseek-v4.1-flash" } }));
			expect(runtime.resolveFallbackModel).toHaveBeenCalledTimes(1);
		});

		it("aborts the observer when the fallback retry also fails", async () => {
			mockAgents.runObserver
				.mockRejectedValueOnce(new ObserverStreamError("error", "primary down"))
				.mockRejectedValueOnce(new ObserverStreamError("error", "fallback down"));
			const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
			const { fire, runLaunchedWork, runtime, pi } = setup({ entries });
			runtime.resolveFallbackModel.mockReturnValueOnce({
				ok: true,
				model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
			});

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
			expect(runtime.lastObserverError).toContain("fallback down");
			expect(pi.appendEntry).not.toHaveBeenCalled();
		});

		it("retries the reflector once with the fallback model after a primary error", async () => {
			const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
			mockAgents.runReflector
				.mockRejectedValueOnce(new Error("primary down"))
				.mockResolvedValueOnce({ reflections: [newRef], droppedObservationIds: ["aaaaaaaaaaaa"] });
			const entries = [
				textCustomMessage("raw-1", "aaaaaaaa"),
				observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			];
			const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 10 });
			const fallback = { provider: "opencode-go", id: "deepseek-v4.1-flash" };
			runtime.resolveFallbackModel.mockReturnValueOnce({ ok: true, model: fallback });

			fire();
			await runLaunchedWork();

			expect(mockAgents.runReflector).toHaveBeenCalledTimes(2);
			expect(mockAgents.runReflector).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: { reasoning: true } }));
			expect(mockAgents.runReflector).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: fallback }));
			expect(runtime.lastReflectorError).toBeUndefined();
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("reflector failed (primary down); retrying with fallback model"), "warning");
			expect(pi.appendEntry.mock.calls).toEqual([
				[OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" }],
				[OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }],
			]);
		});

		it("does not retry when no fallback model is configured", async () => {
			mockAgents.runObserver.mockRejectedValueOnce(new Error("observe failed"));
			const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
			const { fire, runLaunchedWork, runtime } = setup({ entries });

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
			expect(runtime.resolveFallbackModel).toHaveBeenCalledTimes(1);
			expect(runtime.lastObserverError).toBe("observe failed");
		});

		it("does not retry a stage that already resolved through the fallback", async () => {
			mockAgents.runObserver.mockRejectedValueOnce(new ObserverStreamError("error", "fallback down"));
			const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
			const { fire, runLaunchedWork, runtime } = setup({ entries });
			runtime.resolveModel.mockReturnValueOnce({
				ok: true,
				model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
				fallbackUsed: true,
				primaryFailure: "primary down",
			});

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
			expect(runtime.resolveFallbackModel).not.toHaveBeenCalled();
		});

		it("uses the fallback model's thinking level on retry", async () => {
			const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
			mockAgents.runObserver
				.mockRejectedValueOnce(new ObserverStreamError("error", "primary down"))
				.mockResolvedValueOnce([obs]);
			const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
			const { fire, runLaunchedWork, runtime } = setup({ entries });
			(runtime.config as any).fallbackModel = { provider: "opencode-go", id: "deepseek-v4.1-flash", thinking: "high" };
			runtime.resolveFallbackModel.mockReturnValueOnce({
				ok: true,
				model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
			});

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenNthCalledWith(1, expect.objectContaining({ thinkingLevel: "minimal" }));
			expect(mockAgents.runObserver).toHaveBeenNthCalledWith(2, expect.objectContaining({ thinkingLevel: "high" }));
		});

		it("caps the observer chunk to a smaller-context fallback window", async () => {
			const first = observation("111111111111", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
			mockAgents.runObserver.mockResolvedValueOnce([first]);
			const entries = [
				textCustomMessage("raw-1", "a".repeat(800)),
				textCustomMessage("raw-2", "b".repeat(800)),
			];
			const { fire, runLaunchedWork, runtime, ctx } = setup({ entries });
			(runtime.config as any).fallbackModel = { provider: "opencode-go", id: "deepseek-v4.1-flash" };
			runtime.resolveModel.mockReturnValueOnce({
				ok: true,
				model: { provider: "anthropic", contextWindow: 200000 },
			});
			// Only the fallback model advertises a window; its 100-token window caps the
			// chunk at the 256-token minimum so a single source entry fits per run.
			ctx.modelRegistry = { find: vi.fn(() => ({ contextWindow: 100 })), streamSimple: vi.fn() };

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenNthCalledWith(1, expect.objectContaining({ allowedSourceEntryIds: ["raw-1"] }));
		});
	});
});

describe("observer chunk cap", () => {
	it("caps an oversized backlog and drains it incrementally across runs", async () => {
		const first = observation("111111111111", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		const second = observation("222222222222", { sourceEntryIds: ["raw-2"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
		const entries = [
			textCustomMessage("raw-1", "a".repeat(800)),
			textCustomMessage("raw-2", "b".repeat(800)),
			textCustomMessage("raw-3", "c".repeat(800)),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, observerChunkMaxTokens: 256 });

		fire();
		await runLaunchedWork();

		// Only the oldest entry fits under the cap; coverage advances to it, not to the backlog tail.
		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(1, expect.objectContaining({ allowedSourceEntryIds: ["raw-1"] }));
		expect(pi.appendEntry).toHaveBeenNthCalledWith(1, OM_OBSERVATIONS_RECORDED, { observations: [first], coversUpToId: "raw-1" });

		// The next run continues from the advanced coverage.
		runtime.consolidationInFlight = false;
		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(2, expect.objectContaining({ allowedSourceEntryIds: ["raw-2"] }));
		expect(pi.appendEntry).toHaveBeenNthCalledWith(2, OM_OBSERVATIONS_RECORDED, { observations: [second], coversUpToId: "raw-2" });
	});

	it("bounds one oversized tool result, preserves provenance, and continues on the next run", async () => {
		const first = observation("333333333333", { sourceEntryIds: ["raw-huge"], tokenCount: 4 });
		const second = observation("555555555555", { sourceEntryIds: ["raw-next"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
		const hugeText = `HEAD:${"m".repeat(2_000)}:TAIL`;
		const entries: TestEntry[] = [
			{
				type: "message",
				id: "raw-huge",
				parentId: null,
				timestamp: "2026-05-02T10:00:00.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "bash",
					content: [{ type: "text", text: hugeText }],
					isError: false,
					timestamp: Date.parse("2026-05-02T10:00:00.000Z"),
				},
			},
			textCustomMessage("raw-next", "later"),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, observerChunkMaxTokens: 100 });

		fire();
		await runLaunchedWork();

		const firstCall = mockAgents.runObserver.mock.calls[0][0];
		expect(firstCall.allowedSourceEntryIds).toEqual(["raw-huge"]);
		expect(firstCall.chunk).toContain("HEAD:");
		expect(firstCall.chunk).toContain(":TAIL");
		expect(firstCall.chunk).toContain("middle omitted: source exceeds observer input budget");
		expect(firstCall.chunk).not.toContain("raw-next");
		expect(pi.appendEntry).toHaveBeenNthCalledWith(1, OM_OBSERVATIONS_RECORDED, { observations: [first], coversUpToId: "raw-huge" });

		// The source id still points at the full ledger entry; the next run starts
		// after it instead of retrying the oversized input forever.
		runtime.consolidationInFlight = false;
		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(2, expect.objectContaining({ allowedSourceEntryIds: ["raw-next"] }));
		expect(pi.appendEntry).toHaveBeenNthCalledWith(2, OM_OBSERVATIONS_RECORDED, { observations: [second], coversUpToId: "raw-next" });
	});

	it("derives the cap from the resolved model's context window when not configured", async () => {
		const obs = observation("444444444444", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [
			textCustomMessage("raw-1", "a".repeat(800)),
			textCustomMessage("raw-2", "b".repeat(800)),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries });
		// contextWindow 1,280 -> cap = floor(1,280 * 0.2) = 256, so only raw-1 fits.
		runtime.resolveModel.mockReturnValue({ ok: true, model: { reasoning: true, contextWindow: 1_280 } } as any);

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ allowedSourceEntryIds: ["raw-1"] }));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, expect.objectContaining({ coversUpToId: "raw-1" }));
	});
});

describe("consolidateWhenIdle", () => {
	const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
	const dueEntries = [textCustomMessage("raw-1", "aaaaaaaa")];

	it("launches only from agent_settled", () => {
		const { fireAgentStart, fireTurnEnd, fireAgentSettled, runtime } = setup({ entries: dueEntries, consolidateWhenIdle: true });

		fireAgentStart();
		fireTurnEnd();
		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();

		fireAgentSettled();
		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("keeps the default entrypoints when disabled", () => {
		const { fireAgentSettled, fireTurnEnd, runtime } = setup({ entries: dueEntries, consolidateWhenIdle: false });

		fireAgentSettled();
		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
		fireTurnEnd();
		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("passes the run's abort signal to the workers", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const { fireAgentSettled, runLaunchedWork } = setup({ entries: dueEntries, consolidateWhenIdle: true });

		fireAgentSettled();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
	});

	it("aborts an in-flight run when the agent starts, without reporting a failure", async () => {
		mockAgents.runObserver.mockImplementationOnce((args: { signal: AbortSignal }) => new Promise((_, reject) => {
			if (args.signal.aborted) return reject(new Error("aborted"));
			args.signal.addEventListener("abort", () => reject(new Error("aborted")));
		}));
		const { fireAgentSettled, fireAgentStart, runLaunchedWork, runtime, pi, ctx } = setup({ entries: dueEntries, consolidateWhenIdle: true });

		fireAgentSettled();
		const work = runLaunchedWork();
		expect(runtime.consolidationInFlight).toBe(true);

		fireAgentStart();
		await work;

		expect(runtime.abortConsolidation).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.lastObserverError).toBeUndefined();
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("failed"), "warning");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: memory workers paused while the agent runs (consolidateWhenIdle)",
			"info",
		);
	});

	it("does not retry with the fallback model when the run was aborted", async () => {
		mockAgents.runObserver.mockImplementationOnce((args: { signal: AbortSignal }) => new Promise((_, reject) => {
			if (args.signal.aborted) return reject(new Error("aborted"));
			args.signal.addEventListener("abort", () => reject(new Error("aborted")));
		}));
		const { fireAgentSettled, fireAgentStart, runLaunchedWork, runtime, pi } = setup({ entries: dueEntries, consolidateWhenIdle: true });
		runtime.resolveFallbackModel.mockReturnValue({ ok: true, model: { provider: "opencode-go", id: "fallback" } });

		fireAgentSettled();
		const work = runLaunchedWork();
		await vi.waitFor(() => expect(mockAgents.runObserver).toHaveBeenCalledTimes(1));
		fireAgentStart();
		await work;

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(runtime.resolveFallbackModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not abort anything when no run is in flight", () => {
		const { fireAgentStart, runtime, ctx } = setup({ entries: dueEntries, consolidateWhenIdle: true });

		fireAgentStart();

		expect(runtime.abortConsolidation).toHaveBeenCalledTimes(1);
		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

describe("bounded worker memory in consolidation", () => {
	it("sends the observer only the newest prior memory that fits workerMemoryMaxTokens", async () => {
		const old = [1, 2, 3].map((i) => observation(`a${i}`.padEnd(12, "a"), { sourceEntryIds: [`raw-${i}`], content: `Old ${"o".repeat(120)}` }));
		const entries = [
			textCustomMessage("raw-1", "a"), textCustomMessage("raw-2", "b"), textCustomMessage("raw-3", "c"),
			observationsRecordedEntry("om-obs", { observations: old, coversUpToId: "raw-3" }),
			textCustomMessage("raw-4", "dddddddd"),
		];
		mockAgents.runObserver.mockResolvedValueOnce([observation("cccccccccccc", { sourceEntryIds: ["raw-4"] })]);
		const { fire, runLaunchedWork } = setup({ entries, workerMemoryMaxTokens: 50 });

		fire();
		await runLaunchedWork();

		const args = mockAgents.runObserver.mock.calls[0][0];
		expect(args.priorObservations).toHaveLength(1);
		expect(args.priorObservations[0]).toContain("[a3aaaaaaaaaa]");
	});
});
