import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { activeLevel, EFFORT_MESSAGE, failingTurnStreak, raise } from "./policy.ts";

type Step = "user" | "turn" | "failedTurn" | { effort: string };

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function messages(step: "user" | "turn" | "failedTurn"): AgentMessage[] {
	if (step === "user") return [{ role: "user", content: "do it", timestamp: 0 }];
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }],
			api: "anthropic-messages",
			provider: "pi-sub-anthropic",
			model: "claude-opus-5-5",
			usage,
			stopReason: "toolUse",
			timestamp: 0,
		},
		{ role: "toolResult", toolCallId: "t", toolName: "bash", content: [], isError: step === "failedTurn", timestamp: 0 },
	];
}

/** A linear branch from steps; an effort step is a change message whose details carry `level`. */
function branch(...steps: Step[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	const base = () => ({ id: `e${entries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-10-25T00:00:00Z" });
	for (const step of steps) {
		if (typeof step === "object") {
			entries.push({ ...base(), type: "custom_message", customType: EFFORT_MESSAGE, content: "", display: true, details: { level: step.effort, reason: "r" } });
			continue;
		}
		for (const message of messages(step)) entries.push({ ...base(), type: "message", message });
	}
	return entries;
}

test("each user message starts at the selected level", () => {
	assert.equal(activeLevel(branch(), "high"), "high");
	assert.equal(activeLevel(branch("user", { effort: "max" }, "turn", "user", "turn"), "high"), "high");
});

test("the latest change since the user message wins", () => {
	assert.equal(activeLevel(branch("user", "turn", { effort: "low" }, "turn", { effort: "xhigh" }, "turn"), "high"), "xhigh");
});

test("a change with an unknown level is ignored", () => {
	assert.equal(activeLevel(branch("user", { effort: "low" }, "turn", { effort: "turbo" }), "high"), "low");
});

test("failing turns are counted back to the first turn without a failure", () => {
	assert.equal(failingTurnStreak(branch("user", "failedTurn", "turn", "failedTurn", "failedTurn")), 2);
	assert.equal(failingTurnStreak(branch("user", "failedTurn", "failedTurn", "turn")), 0);
});

test("a user message or an effort change starts a new streak", () => {
	assert.equal(failingTurnStreak(branch("failedTurn", "failedTurn", "user", "failedTurn")), 1);
	assert.equal(failingTurnStreak(branch("user", "failedTurn", "failedTurn", { effort: "xhigh" }, "failedTurn")), 1);
});

test("raising moves to the next supported level and stops at the top", () => {
	assert.equal(raise("high", ["low", "medium", "high", "xhigh", "max"]), "xhigh");
	assert.equal(raise("medium", ["low", "medium", "high", "max"]), "high");
	assert.equal(raise("high", ["low", "medium", "high"]), undefined);
});
