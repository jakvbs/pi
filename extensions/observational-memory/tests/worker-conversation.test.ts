import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runObserver } from "../src/agents/observer/agent.ts";
import { runReflector } from "../src/agents/reflector/agent.ts";
import { observationPoolMetrics } from "../src/agents/reflector/pool.ts";
import { observation } from "./fixtures/session.ts";

// Pi keeps provider resources per routing id, e.g. an OpenAI Codex WebSocket. A worker
// conversation's id is never reused, so the conversation releases its resources when it ends.
describe("worker conversations release their provider resources", () => {
	let requestIds: (string | undefined)[];
	let releasedIds: (string | undefined)[];
	let unregister: () => void;

	beforeEach(() => {
		requestIds = [];
		releasedIds = [];
		unregister = registerSessionResourceCleanup((sessionId) => releasedIds.push(sessionId));
	});

	afterEach(() => unregister());

	const modelRegistry = {
		streamSimple: (_model: unknown, _context: unknown, options?: { sessionId?: string }) => {
			requestIds.push(options?.sessionId);
			return {} as any;
		},
	};

	function loopThat(end: "returns" | "throws"): any {
		return (_prompts: unknown, _context: unknown, _config: unknown, _signal: unknown, streamFn: any) => ({
			async *[Symbol.asyncIterator]() {
				await streamFn({}, { messages: [] }, {});
				if (end === "throws") throw new Error("connection reset");
			},
			result: async () => [],
		});
	}

	const workers = {
		observer: (agentLoop: any) =>
			runObserver({
				model: {} as any,
				priorReflections: [],
				priorObservations: [],
				chunk: "[Source entry id: entry-a]\nSome content.",
				allowedSourceEntryIds: ["entry-a"],
				agentLoop,
				modelRegistry,
			}),
		reflector: (agentLoop: any) =>
			runReflector({
				model: {} as any,
				reflections: [],
				observations: [observation("aaaaaaaaaaaa")],
				pool: observationPoolMetrics([observation("aaaaaaaaaaaa")], 1),
				agentLoop,
				modelRegistry,
			}),
	};

	for (const [stage, run] of Object.entries(workers)) {
		it(`${stage}: after the conversation ends`, async () => {
			await run(loopThat("returns"));

			expect(requestIds).toHaveLength(1);
			expect(requestIds[0]).toEqual(expect.any(String));
			expect(releasedIds).toEqual(requestIds);
		});

		it(`${stage}: after the conversation fails`, async () => {
			await expect(run(loopThat("throws"))).rejects.toThrow("connection reset");

			expect(releasedIds).toEqual(requestIds);
		});
	}
});

// A provider error alone, such as a bare "WebSocket error", cannot say whether the network or the
// server dropped the request; the provider's diagnostic details travel with it into the warning.
describe("worker conversations report the provider's diagnostic details", () => {
	const modelRegistry = { streamSimple: () => ({}) as any };

	function loopEndingWith(message: Record<string, unknown>): any {
		return () => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "message_end", message: { role: "assistant", content: [], ...message } };
			},
			result: async () => [],
		});
	}

	const observe = (agentLoop: any) =>
		runObserver({
			model: {} as any,
			priorReflections: [],
			priorObservations: [],
			chunk: "[Source entry id: entry-a]\nSome content.",
			allowedSourceEntryIds: ["entry-a"],
			agentLoop,
			modelRegistry,
		});

	it("appends each diagnostic's details to the error", async () => {
		const agentLoop = loopEndingWith({
			stopReason: "error",
			errorMessage: "WebSocket error",
			diagnostics: [
				{
					type: "websocket_stream_failure",
					timestamp: 1,
					details: { socketReused: false, framesReceived: 2, msSinceRequest: 25000, msSinceLastFrame: 15000 },
				},
				{ type: "provider_transport_failure", timestamp: 1, details: { phase: "after_message_stream_start", requestBytes: 812 } },
				{ type: "without_details", timestamp: 1 },
			],
		});

		await expect(observe(agentLoop)).rejects.toThrow(
			'observer stream ended with stopReason "error": WebSocket error [websocket_stream_failure(socketReused=false framesReceived=2 msSinceRequest=25000 msSinceLastFrame=15000), provider_transport_failure(phase=after_message_stream_start requestBytes=812)]',
		);
	});

	it("keeps an error without diagnostics as it is", async () => {
		const agentLoop = loopEndingWith({ stopReason: "error", errorMessage: "WebSocket error" });

		await expect(observe(agentLoop)).rejects.toThrow(/^observer stream ended with stopReason "error": WebSocket error$/);
	});
});
