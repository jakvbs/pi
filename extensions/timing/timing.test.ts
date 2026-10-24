import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { appendStamp, formatDuration, lastText, runDuration } from "./timing.ts";

const T0 = Date.parse("2026-10-23T10:00:00.000Z");

/** Builds a linear branch; `at` is seconds after T0 and is both the entry and the message time. */
function branch(...specs: Array<{ at: number; kind: "user" | "toolUse" | "stop" | "error" | "custom_message" }>) {
	const entries = specs.map((spec, index): SessionEntry => {
		const base = {
			id: `e${index}`,
			parentId: index === 0 ? null : `e${index - 1}`,
			timestamp: new Date(T0 + spec.at * 1000).toISOString(),
		};
		const timestamp = T0 + spec.at * 1000;
		if (spec.kind === "custom_message") {
			return { ...base, type: "custom_message", customType: "x", content: "", display: false } as SessionEntry;
		}
		const message =
			spec.kind === "user"
				? { role: "user", content: "hi", timestamp }
				: { role: "assistant", content: [], stopReason: spec.kind, timestamp };
		return { ...base, type: "message", message } as unknown as SessionEntry;
	});
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	return { entries, getEntry: (id: string) => byId.get(id) };
}

test("a run lasts from its first user message to the response that ends it", () => {
	const { entries, getEntry } = branch(
		{ at: 0, kind: "user" },
		{ at: 5, kind: "toolUse" },
		{ at: 7, kind: "user" }, // steering message inside the same run
		{ at: 9, kind: "error" }, // retried, so the run continues
		{ at: 12, kind: "stop" },
		{ at: 100, kind: "user" },
		{ at: 130, kind: "stop" },
	);
	assert.equal(runDuration(entries[4]!, getEntry), 12_000);
	assert.equal(runDuration(entries[6]!, getEntry), 30_000);
	assert.equal(runDuration(entries[1]!, getEntry), undefined);
});

test("a run started by an extension message is measured from that message", () => {
	const { entries, getEntry } = branch(
		{ at: 0, kind: "user" },
		{ at: 4, kind: "stop" },
		{ at: 50, kind: "custom_message" },
		{ at: 53, kind: "stop" },
	);
	assert.equal(runDuration(entries[1]!, getEntry), 4_000);
	assert.equal(runDuration(entries[3]!, getEntry), 3_000);
});

test("stamps go after the last non-empty text block", () => {
	const content = [
		{ type: "text", text: "first" },
		{ type: "toolCall" },
		{ type: "text", text: "  last  " },
		{ type: "text", text: " " },
	];
	assert.equal(lastText(content), "last");
	assert.equal(lastText([{ type: "toolCall" }]), undefined);
});

test("durations and stamp layout", () => {
	assert.equal(formatDuration(37_400), "0:37");
	assert.equal(formatDuration(157_000), "2:37");
	assert.equal(formatDuration(3_757_000), "1:02:37");
	assert.equal(
		appendStamp("text", "10:00:00", 12, (label) => `<${label}>`),
		"text\n\n`\u00a0\u00a0\u00a0\u00a0<10:00:00>`",
	);
});
