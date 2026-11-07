// Every provider receives a transcript its API accepts, including after pi exited while a tool ran.
import { afterEach, describe, expect, it } from "vitest";
import { registerApiProvider, resetApiProviders, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Message, Model, StopReason, ToolCall } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Not a built-in provider name, so dispatch reaches the registered API provider, as for an extension's provider.
const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "extension-anthropic",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
};

const bashCall: ToolCall = { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "sleep 40" } };

function assistant(content: AssistantMessage["content"], stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 2,
	};
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

const missingResult = {
	role: "toolResult",
	toolCallId: "call_1",
	toolName: "bash",
	content: [{ type: "text", text: "No result provided" }],
	isError: true,
};

describe("normalizeContext tool call pairing", () => {
	it("answers a tool call that pi exited during, before the next user message", () => {
		const { messages } = normalizeContext({
			messages: [user("run it"), assistant([bashCall], "toolUse"), user("did it finish?")],
		});

		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		expect(messages[2]).toMatchObject(missingResult);
	});

	it("answers a tool call at the end of the transcript", () => {
		const { messages } = normalizeContext({ messages: [user("run it"), assistant([bashCall], "toolUse")] });

		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(messages[2]).toMatchObject(missingResult);
	});

	it("drops an aborted assistant turn instead of answering its partial tool call", () => {
		const { messages } = normalizeContext({
			messages: [user("run it"), assistant([bashCall], "aborted"), user("try again")],
		});

		expect(messages.map((message) => message.role)).toEqual(["user", "user"]);
	});

	it("keeps a real result and moves a system message that interrupts the call after it", () => {
		const result: Message = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "bash",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 4,
		};
		const notice: Message = { role: "system", content: "notice", timestamp: 3 };

		const { messages } = normalizeContext({
			messages: [user("run it"), assistant([bashCall], "toolUse"), notice, result],
		});

		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "system"]);
		expect(messages[2]).toBe(result);
		expect(normalizeContext({ messages }).messages).toEqual(messages);
	});

	it("tolerates messages without content from untyped callers", () => {
		const messages = [user("hi"), { ...assistant([], "stop"), content: null }] as unknown as Message[];

		expect(normalizeContext({ messages }).messages.map((message) => message.content)).toEqual(["hi", []]);
	});
});

describe("provider dispatch", () => {
	afterEach(() => {
		resetApiProviders();
	});

	it("gives a provider registered outside pi-ai a paired transcript after pi exited during a tool call", async () => {
		let received: Message[] = [];
		registerApiProvider({
			api: "anthropic-messages",
			stream: () => {
				throw new Error("stream is not used by this test");
			},
			streamSimple: (_model, context) => {
				received = context.messages;
				const output = assistant([{ type: "text", text: "ok" }], "stop");
				const stream = new AssistantMessageEventStream();
				stream.push({ type: "start", partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end(output);
				return stream;
			},
		});
		const context: Context = {
			systemPrompt: "system",
			messages: [user("run it"), assistant([bashCall], "toolUse"), user("did it finish?")],
		};

		await streamSimple(model, context).result();

		expect(received.map((message) => message.role)).toEqual(["system", "user", "assistant", "toolResult", "user"]);
		expect(received[3]).toMatchObject(missingResult);
	});
});
