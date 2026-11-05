import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunningTurnHandoff } from "@earendil-works/pi-coding-agent";
import { type Step, TurnTracker } from "./tracker.ts";

const CADENCE = { everyMs: 60_000, everyToolCalls: 8 };
const HANDOFF: RunningTurnHandoff = {
	kind: "running",
	goal: "Fix the bug.",
	done: "Read the file.",
	next: "Run tests.",
};

/** A step that ends at `at` seconds and made `calls` tool calls. */
function step(at: number, calls = 1, text = `step at ${at}s`): Step {
	const call = { name: "bash", args: "{}", result: "ok", isError: false };
	return { at: at * 1000, thinking: "", text, calls: Array.from({ length: calls }, () => call) };
}

describe("TurnTracker", () => {
	it("asks for a running handoff a minute into the turn, then a minute after the last one", () => {
		const tracker = new TurnTracker(CADENCE);
		tracker.userMessage("fix the bug", 0);
		assert.equal(tracker.step(step(30), 0), undefined);
		const first = tracker.step(step(61), 61_000);
		assert.deepEqual(
			{ kind: first?.kind, goal: first?.goal, previous: first?.previous, steps: first?.steps.map((s) => s.text) },
			{ kind: "running", goal: "fix the bug", previous: undefined, steps: ["step at 30s", "step at 61s"] },
		);
		assert.ok(first && tracker.written(first, HANDOFF, 65_000));

		assert.equal(tracker.step(step(120), 120_000), undefined);
		const second = tracker.step(step(126), 126_000);
		assert.equal(second?.previous, HANDOFF);
		assert.deepEqual(
			second?.steps.map((s) => s.text),
			["step at 120s", "step at 126s"],
		);
	});

	it("asks after eight tool calls however short the turn is, and never while a request is out", () => {
		const tracker = new TurnTracker(CADENCE);
		tracker.userMessage("go", 0);
		assert.equal(tracker.step(step(1, 5), 1_000), undefined);
		const request = tracker.step(step(2, 3), 2_000);
		assert.equal(request?.steps.length, 2);
		assert.equal(tracker.step(step(3, 9), 3_000), undefined);
		assert.ok(request && tracker.written(request, HANDOFF, 4_000));
		const next = tracker.step(step(5, 0), 5_000);
		assert.deepEqual(
			next?.steps.map((s) => s.text),
			["step at 3s", "step at 5s"],
		);
	});

	it("a failed request waits a full minute and keeps its steps for the next one", () => {
		const tracker = new TurnTracker(CADENCE);
		tracker.userMessage("go", 0);
		const request = tracker.step(step(61), 61_000);
		assert.ok(request);
		tracker.failed(request, 62_000);
		assert.equal(tracker.step(step(100, 7), 100_000), undefined);
		assert.deepEqual(
			tracker.step(step(122), 122_000)?.steps.map((s) => s.text),
			["step at 61s", "step at 100s", "step at 122s"],
		);
	});

	it("a short turn gets no finished handoff; a turn with a running one gets one with every step not yet covered", () => {
		const tracker = new TurnTracker(CADENCE);
		tracker.userMessage("short", 0);
		tracker.step(step(5), 5_000);
		assert.equal(tracker.reply(step(6, 0, "Done.")), undefined);

		tracker.userMessage("long", 100_000);
		const running = tracker.step(step(170), 170_000);
		assert.ok(running && tracker.written(running, HANDOFF, 171_000));
		tracker.step(step(180), 180_000);
		const late = tracker.step(step(240), 240_000);
		assert.equal(late?.kind, "running");
		const finished = tracker.reply(step(250, 0, "All fixed."));
		assert.deepEqual(
			{ kind: finished?.kind, previous: finished?.previous, steps: finished?.steps.map((s) => s.text) },
			{ kind: "finished", previous: HANDOFF, steps: ["step at 180s", "step at 240s", "All fixed."] },
		);
		assert.ok(late);
		assert.equal(tracker.written(late, HANDOFF, 251_000), false);
	});

	it("a finished handoff is still written after the next message, but not after another turn ended", () => {
		const tracker = new TurnTracker(CADENCE);
		const finishedTurn = () => {
			tracker.userMessage("task", 0);
			const running = tracker.step(step(61), 61_000);
			assert.ok(running && tracker.written(running, HANDOFF, 62_000));
			const finished = tracker.reply(step(70, 0, "Done."));
			assert.ok(finished);
			return finished;
		};

		const kept = finishedTurn();
		tracker.userMessage("next task", 80_000);
		assert.equal(tracker.written(kept, undefined, 81_000), true);

		const stale = finishedTurn();
		tracker.userMessage("quick question", 80_000);
		tracker.reply(step(85, 0, "Yes."));
		assert.equal(tracker.written(stale, undefined, 90_000), false);
	});

	it("a steering message starts a new turn, so the running request of the old one is not written", () => {
		const tracker = new TurnTracker(CADENCE);
		tracker.userMessage("task", 0);
		const request = tracker.step(step(61), 61_000);
		assert.equal(tracker.pendingId(), request?.id);
		tracker.userMessage("also check the docs", 62_000);
		assert.ok(request);
		assert.equal(tracker.written(request, HANDOFF, 63_000), false);
		assert.equal(tracker.pendingId(), undefined);
	});
});
