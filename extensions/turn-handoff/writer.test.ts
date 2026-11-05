import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { HandoffRequest, Step } from "./tracker.ts";
import { renderRequest, writeHandoff } from "./writer.ts";

const MODEL: Model<Api> = {
	id: "claude-sonnet-5-5",
	name: "Claude Sonnet 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	contextWindow: 200_000,
	maxTokens: 64_000,
};

/** A registry whose model answers every request with `answer`, recording what it was sent. */
function registry(answer: AssistantMessage) {
	const sent: { context: Context; options: SimpleStreamOptions | undefined }[] = [];
	return {
		sent,
		streamSimple(_model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
			sent.push({ context, options });
			const stream = createAssistantMessageEventStream();
			const { stopReason } = answer;
			if (stopReason === "error" || stopReason === "aborted")
				stream.push({ type: "error", reason: stopReason, error: answer });
			else if (stopReason !== "pending") stream.push({ type: "done", reason: stopReason, message: answer });
			return stream;
		},
	};
}

function step(text: string, result = "ok"): Step {
	return {
		at: Date.UTC(2026, 10, 5, 12),
		thinking: "",
		text,
		calls: [{ name: "bash", args: '{"command":"npm test"}', result, isError: false }],
	};
}

const PREVIOUS = {
	kind: "running",
	goal: "Naprawić logowanie.",
	done: "Przeczytano auth.ts.",
	next: "Uruchomić testy.",
} as const;

const RUNNING: HandoffRequest = {
	id: 1,
	kind: "running",
	goal: "napraw logowanie",
	previous: PREVIOUS,
	steps: [step("Uruchamiam testy.", "1 failed")],
};

describe("writeHandoff", () => {
	it("returns the fields of the model's write_handoff call on one line each, and sends the turn as one user message", async () => {
		const answer = fauxAssistantMessage(
			fauxToolCall("write_handoff", {
				goal: "Naprawić logowanie.",
				done: "Test auth.test.ts\n  nie przechodzi.",
				next: "Agent poprawia porównanie tokenu.",
			}),
			{ stopReason: "toolUse" },
		);
		const fake = registry(answer);

		const { handoff } = await writeHandoff(RUNNING, { model: MODEL, thinking: "low" }, fake);

		assert.deepEqual(handoff, {
			kind: "running",
			goal: "Naprawić logowanie.",
			done: "Test auth.test.ts nie przechodzi.",
			next: "Agent poprawia porównanie tokenu.",
		});
		const [request] = fake.sent;
		assert.equal(request.options?.reasoning, "low");
		assert.deepEqual(
			request.context.tools?.map((tool) => tool.name),
			["write_handoff"],
		);
		assert.equal(request.context.messages.length, 1);
		assert.equal(request.context.messages[0].content, renderRequest(RUNNING));
	});

	it("rejects an answer without every field, and a failed request with its error", async () => {
		const partial = fauxAssistantMessage(fauxToolCall("write_handoff", { goal: "Cel.", done: " ", next: "Dalej." }));
		await assert.rejects(
			writeHandoff(RUNNING, { model: MODEL, thinking: "off" }, registry(partial)),
			/did not call write_handoff with every field/,
		);
		const failed = fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });
		await assert.rejects(writeHandoff(RUNNING, { model: MODEL, thinking: "off" }, registry(failed)), /overloaded/);
	});

	it("asks for write_summary at the end of a turn and sends no reasoning setting with thinking off", async () => {
		const fake = registry(fauxAssistantMessage(fauxToolCall("write_summary", { summary: "Naprawiono logowanie." })));
		const request: HandoffRequest = { ...RUNNING, kind: "finished", previous: PREVIOUS, reply: "Gotowe." };

		const { handoff } = await writeHandoff(request, { model: MODEL, thinking: "off" }, fake);

		assert.deepEqual(handoff, { kind: "finished", summary: "Naprawiono logowanie." });
		assert.equal(fake.sent[0].options?.reasoning, undefined);
		assert.match(String(fake.sent[0].context.messages[0].content), /<reply>\nGotowe\.\n<\/reply>$/);
	});
});

describe("renderRequest", () => {
	it("cuts a long result and, over the length limit, leaves out the oldest steps but always keeps the newest", () => {
		const long = "x".repeat(700);
		const many: HandoffRequest = {
			id: 2,
			kind: "running",
			goal: "cel",
			previous: undefined,
			steps: Array.from({ length: 40 }, (_, index) => step(`krok ${index}`, long)),
		};

		const text = renderRequest(many);

		assert.match(text, /^<user_message>\ncel\n<\/user_message>\n\n<steps>\n\(\d+ earlier steps left out\)/);
		assert.ok(text.includes(`result: ${"x".repeat(500)} [... 200 more chars]`));
		assert.ok(text.includes("text: krok 39"));
		assert.ok(!text.includes("text: krok 0\n"));

		const huge: HandoffRequest = { ...many, steps: [step("jedyny", "y".repeat(100_000))] };
		assert.ok(renderRequest(huge).includes("text: jedyny"));
	});
});
