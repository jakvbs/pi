/**
 * pi calls a provider without `reasoning` when thinking is off. The provider
 * used to omit `thinking` then, and Claude Haiku 5.5 kept thinking adaptively:
 * with a 200-token cap some replies ended inside a thinking block with no text.
 * pi's built-in provider sends `thinking: {type: "disabled"}` whenever the
 * model's `thinkingLevelMap` does not hide `off`, and so does this one now.
 *
 * Hypothesis: every catalog model that allows `off` accepts `disabled` on OAuth,
 * including when the history already holds signed thinking blocks and when
 * thinking is switched off in the middle of a tool loop.
 *
 * Established on 2026-10-24, before the change (thinking omitted):
 * Haiku 5.5 answered with a thinking block (26-54 output tokens on the prompt
 * below); the eight other models answered without one.
 *
 * Result with `disabled` (2026-10-24): all nine models return 200 with text
 * only (Haiku 5.5: 5 output tokens), and so does each of them after a tool call
 * that followed thinking and after signed thinking in the history. Opus 4.7 did
 * not think on the first prompt in five attempts, so its history case carried
 * no thinking block.
 *
 * Run: node --experimental-strip-types --import ../../packages/coding-agent/src/experimental/source-resolver.ts diagnostics/thinking-off-probe.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiSubAnthropicStream } from "../stream.ts";

const token: string | undefined = JSON.parse(
	fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"),
)["pi-sub-anthropic"]?.access;
if (!token) {
	console.error("No pi-sub-anthropic credential found. Run: /login pi-sub-anthropic");
	process.exit(1);
}

const stream = createPiSubAnthropicStream({});
const PROMPT =
	"Think carefully step by step: a bat and a ball cost 1.10 in total, the bat costs 1.00 more than the ball. What does the ball cost? Answer with the number only.";
const TOOLS = [
	{
		name: "add",
		description: "Add two numbers",
		parameters: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
	},
];

const modelFor = (id: string): any => ({
	id,
	name: id,
	api: "anthropic-messages",
	provider: "pi-sub-anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	contextWindow: 200000,
	maxTokens: 64000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { forceAdaptiveThinking: !id.endsWith("-4-5") },
});

async function call(model: any, messages: any[], reasoning?: string, withTools = false) {
	return stream(model, { messages, ...(withTools ? { tools: TOOLS } : {}) } as any, {
		apiKey: token,
		maxTokens: 2048,
		reasoning,
	} as any).result();
}

function report(label: string, r: any): void {
	const parts = r.content.map((p: any) => p.type).join(",");
	console.log(`${label.padEnd(44)} ${r.stopReason.padEnd(8)} parts=${parts} out=${r.usage.output} ${r.errorMessage?.slice(0, 200) ?? ""}`);
}

console.log("=== thinking off: every model whose map allows off ===");
const ids = [
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-opus-4-5",
	"claude-sonnet-5",
	"claude-sonnet-4-6",
	"claude-sonnet-4-5",
	"claude-haiku-5-5",
	"claude-haiku-4-5",
];
for (const id of ids) {
	report(id, await call(modelFor(id), [{ role: "user", content: PROMPT, timestamp: 0 }]));
}

console.log("\n=== off after thinking: signed thinking in history, then mid tool loop ===");
const TASK =
	"First reason carefully about which two primes below 50 have the largest product that is still below 1000, then call the add tool with those two primes.";

async function offAfterThinking(id: string): Promise<string[]> {
	const model = modelFor(id);
	const lines: string[] = [];
	const line = (label: string, r: any) => {
		const parts = r.content.map((p: any) => p.type).join(",");
		lines.push(`${`${id} ${label}`.padEnd(44)} ${r.stopReason.padEnd(8)} parts=${parts} ${r.errorMessage?.slice(0, 200) ?? ""}`);
	};
	const ask = { role: "user", content: PROMPT, timestamp: 0 };
	let thought: any;
	for (let attempt = 0; attempt < 5; attempt++) {
		thought = await call(model, [ask], "high");
		if (thought.content.some((p: any) => p.type === "thinking")) break;
	}
	line("turn 1 at high", thought);
	line("turn 2 off", await call(model, [ask, thought, { role: "user", content: "And the bat? Number only.", timestamp: 0 }]));

	const task = { role: "user", content: TASK, timestamp: 0 };
	let toolTurn: any;
	for (let attempt = 0; attempt < 5; attempt++) {
		toolTurn = await call(model, [task], "high", true);
		const types = toolTurn.content.map((p: any) => p.type);
		if (types.includes("thinking") && types.includes("toolCall")) break;
	}
	line("tool turn at high", toolTurn);
	const toolCall = toolTurn.content.find((p: any) => p.type === "toolCall");
	if (toolCall) {
		const result = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: "add",
			content: [{ type: "text", text: "42" }],
			isError: false,
			timestamp: 0,
		};
		line("after tool result, off", await call(model, [task, toolTurn, result], undefined, true));
	}
	return lines;
}

for (const lines of await Promise.all(ids.map(offAfterThinking))) console.log(lines.join("\n"));
