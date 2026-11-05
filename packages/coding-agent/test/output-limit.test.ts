import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import type { OutputHead } from "../src/core/tools/output-head.ts";
import { limitOutput } from "../src/core/tools/output-limit.ts";

const location = { path: "/tmp/out.txt", firstLine: 1, totalLines: 1 };

/** The whole text as an output head, counted by hand rather than by the collector. */
const whole = (text: string): OutputHead => ({
	text,
	totalLines: text.split("\n").length,
	totalBytes: Buffer.byteLength(text),
});

describe("limitOutput", () => {
	it("returns text within the budget unchanged", () => {
		expect(limitOutput(whole("a\nb"), 3, location)).toMatchObject({ text: "a\nb", truncation: { truncated: false } });
	});

	it("shows the start of a first line that alone exceeds the budget, without splitting a character", () => {
		const { text, truncation } = limitOutput(whole("€".repeat(200)), 300, location);

		const notice =
			"[Line 1 alone exceeds the 300B output limit; showing its start. Full output: /tmp/out.txt. Search it with grep, or cut the line with bash.]";
		expect(truncation.firstLineExceedsLimit).toBe(true);
		expect(text.endsWith(`\n\n${notice}`)).toBe(true);
		const start = text.slice(0, -notice.length - 2);
		expect(start).toBe("€".repeat(start.length));
		expect(start.length).toBeGreaterThan(0);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300);
	});

	it("returns only the notice when the budget leaves no room for output", () => {
		expect(limitOutput(whole("x".repeat(100)), 10, location).text).toMatch(
			/^\[Line 1 alone exceeds the 10B output limit/,
		);
	});
});

describe("tool budgets smaller than the room tools leave for notices", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-output-limit-"));
	writeFileSync(join(dir, "a.txt"), "alpha\n");
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const options = { maxOutputTokens: 1 };
	const text = (result: { content: { type: string; text?: string }[] }) => result.content[0].text;

	it("keep no output instead of failing", async () => {
		const bash = createBashToolDefinition(dir, { ...options, exposeSessionEnvironment: false });
		expect(text(await bash.execute("call", { command: "true" }, undefined, undefined, undefined as never))).toBe(
			"(no output)",
		);
		const grep = createGrepToolDefinition(dir, options);
		expect(text(await grep.execute("call", { pattern: "alpha" }, undefined, undefined, undefined as never))).toBe(
			"\n\n[0B limit reached]",
		);
		const find = createFindToolDefinition(dir, options);
		expect(text(await find.execute("call", { pattern: "*.txt" }, undefined, undefined, undefined as never))).toBe(
			"\n\n[0B limit reached]",
		);
	});
});
