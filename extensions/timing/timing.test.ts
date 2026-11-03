import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
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

test("an error followed by a new message ends its run", () => {
	const { entries, getEntry } = branch(
		{ at: 0, kind: "user" },
		{ at: 5, kind: "error" },
		{ at: 900, kind: "user" },
		{ at: 914, kind: "stop" },
	);
	assert.equal(runDuration(entries[3]!, getEntry), 14_000);
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

test("durations", () => {
	assert.equal(formatDuration(37_400), "0:37");
	assert.equal(formatDuration(157_000), "2:37");
	assert.equal(formatDuration(3_757_000), "1:02:37");
});

const plainTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: (text) => text,
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => text,
	quote: (text) => text,
	quoteBorder: (text) => text,
	hr: (text) => text,
	listBullet: (text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

/** Renders Markdown with a stamp the way pi's transcript does, with trailing padding and NBSPs as spaces. */
function renderStamped(markdown: string, width: number, label = "10:21:31"): string[] {
	const component = new Markdown(markdown, 1, 0, plainTheme, undefined, {
		transform: (text, availableWidth) => appendStamp(text, label, availableWidth, (stamp) => stamp),
	});
	return component.render(width).map((line) => line.replaceAll("\u00a0", " ").trimEnd());
}

test("a stamp shares the last line of a closing paragraph when it fits", () => {
	assert.deepEqual(renderStamped("zatwierdzam", 30), [" zatwierdzam         10:21:31"]);
	assert.deepEqual(renderStamped("first paragraph\n\nsee **this** and `code`", 40), [
		" first paragraph",
		"",
		" see this and code             10:21:31",
	]);
});

test("a stamp that does not fit the last line takes the next line without a blank one", () => {
	assert.deepEqual(renderStamped("a line that nearly fills it", 30), [
		" a line that nearly fills it",
		"                     10:21:31",
	]);
});

test("a stamp after a list or code block stays a paragraph of its own", () => {
	assert.deepEqual(renderStamped("- one\n- two", 30), [" - one", " - two", "", "                     10:21:31"]);
	assert.deepEqual(renderStamped("see [docs](https://example.com)", 30).at(-1), "                     10:21:31");
});
