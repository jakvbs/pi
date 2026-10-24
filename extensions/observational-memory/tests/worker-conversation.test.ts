import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDropper } from "../src/agents/dropper/agent.ts";
import { runObserver } from "../src/agents/observer/agent.ts";
import { runReflector } from "../src/agents/reflector/agent.ts";
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
				agentLoop,
				modelRegistry,
			}),
		dropper: (agentLoop: any) =>
			runDropper({
				model: {} as any,
				reflections: [],
				observations: [observation("aaaaaaaaaaaa")],
				targetTokens: 1,
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
