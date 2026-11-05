import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const lines = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => `row ${from + i}`).join("\n");

const reportTool: AgentTool = {
	name: "report",
	label: "Report",
	description: "Return a long report",
	parameters: Type.Object({ rows: Type.Number() }),
	execute: async (_id, params) => ({
		content: [
			{ type: "text", text: lines(1, (params as { rows: number }).rows) },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
			{ type: "text", text: "end of report" },
		],
		details: {},
	}),
};

describe("AgentSession tool output limit", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function callReport(rows: number): Promise<ToolResultMessage> {
		const harness = await createHarness({ tools: [reportTool], settings: { toolOutputMaxTokens: 100 } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("report", { rows })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("report");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		if (!result) throw new Error("Expected a tool result");
		return result;
	}

	it("keeps the start of every tool's text and saves the whole text to the named file", async () => {
		const result = await callReport(500);

		const [text, image, ...rest] = result.content;
		expect(rest).toEqual([]);
		expect(image).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
		if (text?.type !== "text") throw new Error("Expected text first");
		expect(Buffer.byteLength(text.text)).toBeLessThanOrEqual(400);
		const notice = text.text.match(
			/\n\n\[Showing lines 1-(\d+) of 501 \(400B output limit\)\. Full output: (\S+)\. Use read with offset=(\d+) to continue, or search it with grep\.\]$/,
		);
		if (!notice) throw new Error(`Expected a notice in ${text.text}`);
		const [, shown, path, offset] = notice;
		expect(text.text.slice(0, notice.index)).toBe(lines(1, Number(shown)));
		expect(Number(offset)).toBe(Number(shown) + 1);
		expect(readFileSync(path, "utf-8")).toBe(`${lines(1, 500)}\nend of report`);
	});

	it("leaves text within the limit as the tool returned it", async () => {
		const result = await callReport(3);

		expect(result.content).toEqual([
			{ type: "text", text: lines(1, 3) },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
			{ type: "text", text: "end of report" },
		]);
	});
});
