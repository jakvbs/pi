/**
 * Hypothesis: with per-message effort markers (compat.supportsMidConvoEffort),
 * changing the thinking level between requests keeps the prompt cache and
 * still changes how much the model thinks.
 *
 * Established by raw probes on OAuth (2026-10-25): the marker shape returns 200
 * on Fable 5.1, Opus 5 / 5.5, Sonnet 5.5 and Haiku 5.5, and a marker after new
 * user input moves thinking from ~100-150 to ~480-610 tokens on Opus 5.5 while
 * reading the whole ~25.9k-token prefix from cache. This probe drives the real
 * provider stream instead of a hand-built body, so it checks the shipped path.
 *
 * Runs one conversation through createPiSubAnthropicStream, alternating the
 * level between low and max, and prints cache usage and thinking length per
 * request. The token is read from pi's auth store and never printed.
 *
 * Run: node --experimental-strip-types \
 *   --import ../../packages/coding-agent/src/experimental/source-resolver.ts \
 *   diagnostics/effort-marker-probe.ts [model-id]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiSubAnthropicStream } from "../stream.ts";

const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
const cred = JSON.parse(fs.readFileSync(authPath, "utf8"))["pi-sub-anthropic"];
if (!cred?.access || cred.expires <= Date.now()) {
	console.error("No valid pi-sub-anthropic credential. Run: /login pi-sub-anthropic");
	process.exit(1);
}

const modelId = process.argv[2] ?? "claude-opus-5-5";
const model: any = {
	id: modelId,
	name: modelId,
	api: "anthropic-messages",
	provider: "pi-sub-anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 128000,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsMidConvoEffort: true },
};

// Large enough to clear every model's minimum cacheable prefix.
const filler = Array.from({ length: 1200 }, (_, i) => `Reference note ${i}: values ${i * 7 % 101}, ${i * 13 % 97}.`).join("\n");
const systemPrompt = `You answer puzzles briefly.\n\n${filler}`;
const question = (n: number) =>
	`Puzzle ${n}: what is the sum of the decimal digits of 3^${40 + n}? Work it out, then answer with the number only.`;

const stream = createPiSubAnthropicStream();
const messages: any[] = [];
const levels = ["low", "max", "low", "max", "low", "max"];
for (const [n, level] of levels.entries()) {
	messages.push({ role: "user", content: [{ type: "text", text: question(n) }], timestamp: Date.now() });
	let reply: any;
	for await (const ev of stream(model, { systemPrompt, messages }, { apiKey: cred.access, reasoning: level } as any)) {
		if (ev.type === "done") reply = ev.message;
		if (ev.type === "error") reply = ev.error;
	}
	const thinking = (reply.content ?? [])
		.filter((b: any) => b.type === "thinking")
		.reduce((sum: number, b: any) => sum + b.thinking.length, 0);
	console.log(
		`${reply.stopReason === "error" ? "ERR" : "OK "} #${n} ${level.padEnd(3)} recorded=${reply.providerThinkingLevel} cacheRead=${reply.usage.cacheRead} cacheWrite=${reply.usage.cacheWrite} output=${reply.usage.output} thinkingChars=${thinking}${reply.errorMessage ? ` ${reply.errorMessage}` : ""}`,
	);
	if (reply.stopReason === "error") process.exit(1);
	messages.push(reply);
}
