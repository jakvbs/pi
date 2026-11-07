import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function seedCompactableSession(harness: Harness): void {
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "x".repeat(500) }],
		timestamp: 1,
	});
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("y".repeat(200), { timestamp: 2 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function runAutoCompaction(harness: Harness): Promise<boolean> {
	return (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("threshold", false);
}

describe("automatic compaction cancellation regressions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// Regression test for #9340.
	it("does not start post-run auto-compaction after abort", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 200, maxTokens: 50 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 50, keepRecentTokens: 1 },
				retry: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic network failure" }),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				harness.session.abortCompaction();
				void harness.session.abort();
			}
		});

		await harness.session.prompt("z".repeat(1000));

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	// Regression test for #9777.
	it("cancels a compaction handler through its abort signal", async () => {
		let markHandlerStarted = () => {};
		const handlerStarted = new Promise<void>((resolve) => {
			markHandlerStarted = resolve;
		});
		let handlerSignal: AbortSignal | undefined;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						handlerSignal = event.signal;
						markHandlerStarted();
						await new Promise<void>((resolve) => event.signal.addEventListener("abort", () => resolve()));
						return {
							compaction: {
								summary: "late",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: 0,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const compaction = runAutoCompaction(harness);
		await handlerStarted;
		const wasCompacting = harness.session.isCompacting;
		await Promise.all([compaction, harness.session.abort()]);

		expect({ wasCompacting, handlerAborted: handlerSignal?.aborted }).toEqual({
			wasCompacting: true,
			handlerAborted: true,
		});
		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	// Regression test for #9777.
	it("cancels synchronously from compaction_start", async () => {
		let handlerCalls = 0;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => {
						handlerCalls++;
						return { cancel: true };
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") harness.session.abortCompaction();
		});

		await runAutoCompaction(harness);

		expect(handlerCalls).toBe(0);
		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
	});

	it("does not start threshold compaction without a compaction handler", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);

		await expect(runAutoCompaction(harness)).resolves.toBe(false);

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("reports a handler that compacted nothing as a failure", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => undefined);
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		await runAutoCompaction(harness);

		const event = harness.eventsOfType("compaction_end").at(-1);
		expect({ aborted: event?.aborted, errorMessage: event?.errorMessage }).toEqual({
			aborted: false,
			errorMessage:
				"Auto-compaction failed: No extension compacted the session. Pi needs a compaction extension to write the summary.",
		});
	});

	it("reports extension cancellation as aborted", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		await runAutoCompaction(harness);

		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
	});
});
