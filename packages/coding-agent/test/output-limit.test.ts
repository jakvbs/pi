import { describe, expect, it } from "vitest";
import { limitOutput } from "../src/core/tools/output-limit.ts";

const location = { path: "/tmp/out.txt", firstLine: 1, totalLines: 1 };

describe("limitOutput", () => {
	it("returns text within the budget unchanged", () => {
		expect(limitOutput("a\nb", 3, location)).toMatchObject({ text: "a\nb", truncation: { truncated: false } });
	});

	it("shows the start of a first line that alone exceeds the budget, without splitting a character", () => {
		const { text, truncation } = limitOutput("€".repeat(200), 300, location);

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
		expect(limitOutput("x".repeat(100), 10, location).text).toMatch(/^\[Line 1 alone exceeds the 10B output limit/);
	});
});
