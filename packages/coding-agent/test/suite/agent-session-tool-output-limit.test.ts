import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { BashExecutionMessage, CustomMessage } from "../../src/core/messages.ts";
import { bashExecutionToText } from "../../src/core/messages.ts";
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

describe("AgentSession limit on other text no person wrote", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const textOf = (content: CustomMessage["content"]) =>
		typeof content === "string"
			? content
			: content.map((block) => (block.type === "text" ? block.text : "")).join("");
	/** The saved whole text, after checking that `text` keeps its start within 400 bytes and names the file. */
	const savedText = (text: string) => {
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(400);
		const notice = text.match(
			/\n\n\[Showing lines 1-(\d+) of 500 \(400B output limit\)\. Full output: (\S+)\. Use read/,
		);
		if (!notice) throw new Error(`Expected a notice in ${text}`);
		expect(text.slice(0, notice.index)).toBe(lines(1, Number(notice[1])));
		return readFileSync(notice[2]!, "utf-8");
	};

	it("limits extension messages whether sent, added before a run, or appended when it settles", async () => {
		let settled = false;
		const harness = await createHarness({
			settings: { toolOutputMaxTokens: 100 },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({
						message: { customType: "started", content: lines(1, 500), display: false },
					}));
					pi.on("agent_before_settle", () => {
						if (settled) return undefined;
						settled = true;
						return {
							entries: [
								{ type: "custom_message", customType: "settled", content: lines(1, 500), display: false },
							],
						};
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.sendCustomMessage({ customType: "sent", content: lines(1, 500), display: false });
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("go");

		const custom = harness.session.messages.filter((message): message is CustomMessage => message.role === "custom");
		expect(custom.map((message) => message.customType)).toEqual(["sent", "started", "settled"]);
		for (const message of custom) expect(savedText(textOf(message.content))).toBe(lines(1, 500));
	});

	it("leaves an extension message within the limit as it was sent", async () => {
		const harness = await createHarness({ settings: { toolOutputMaxTokens: 100 } });
		harnesses.push(harness);
		await harness.session.sendCustomMessage({ customType: "sent", content: lines(1, 3), display: false });

		const [message] = harness.session.messages;
		expect(message).toMatchObject({ role: "custom", content: lines(1, 3) });
	});

	it("keeps the start of a ! command's output, saving the whole of it, within the limit", async () => {
		// 200 tokens are 800 bytes, 400 of them for the output and 400 for the command and the notice.
		const harness = await createHarness({ settings: { toolOutputMaxTokens: 200 } });
		harnesses.push(harness);
		const result = await harness.session.executeBash("seq 1 3000");

		const [message] = harness.session.messages as BashExecutionMessage[];
		expect(message).toMatchObject({ role: "bashExecution", output: result.output, truncated: true });
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(400);
		expect(result.output.startsWith("1\n2\n3\n")).toBe(true);
		expect(readFileSync(result.fullOutputPath!, "utf-8")).toBe(`${lines(1, 3000).replace(/row /g, "")}\n`);
		expect(Buffer.byteLength(bashExecutionToText(message!))).toBeLessThanOrEqual(800);
	});

	it("limits a ! command result an extension recorded, unless it stays out of the context", async () => {
		const harness = await createHarness({ settings: { toolOutputMaxTokens: 200 } });
		harnesses.push(harness);
		const result = { output: lines(1, 500), exitCode: 0, cancelled: false, truncated: false };
		harness.session.recordBashResult("remote", result);
		harness.session.recordBashResult("remote", result, { excludeFromContext: true });

		const [inContext, shownOnly] = harness.session.messages as BashExecutionMessage[];
		expect(inContext!.output).toBe(lines(1, inContext!.output.split("\n").length));
		expect(Buffer.byteLength(inContext!.output)).toBeLessThanOrEqual(400);
		expect(inContext!.truncated).toBe(true);
		expect(readFileSync(inContext!.fullOutputPath!, "utf-8")).toBe(lines(1, 500));
		expect(shownOnly!.output).toBe(lines(1, 500));
	});
});
