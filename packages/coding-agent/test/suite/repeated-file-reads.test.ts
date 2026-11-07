import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("repeated whole-file reads", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** A harness whose model reads `notes.md` with `args` on every prompt; returns the tool results each request carried. */
	async function createReadHarness(args: { offset?: number; limit?: number } = {}) {
		const harness = await createHarness();
		harnesses.push(harness);
		const path = join(harness.tempDir, "notes.md");
		const toolResults: string[][] = [];
		const readNotes = () => fauxAssistantMessage(fauxToolCall("read", { path, ...args }), { stopReason: "toolUse" });
		const record = (context: TranscriptContext) => {
			toolResults.push(
				context.messages
					.filter((message) => message.role === "toolResult")
					.map((message) => getMessageText(message)),
			);
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([readNotes(), record, readNotes(), record]);
		return { harness, path, toolResults };
	}

	it("sends a repeated read of an unchanged file as a note and keeps the full result in the session", async () => {
		const { harness, path, toolResults } = await createReadHarness();
		writeFileSync(path, "line one\nline two\n");

		await harness.session.prompt("read it");
		await harness.session.prompt("read it again");

		expect(toolResults[1]).toEqual([
			"line one\nline two\n",
			`${path} has not changed since its full content last appeared earlier in this conversation. Use that content.`,
		]);
		const stored = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(stored.map((message) => getMessageText(message))).toEqual([
			"line one\nline two\n",
			"line one\nline two\n",
		]);
	});

	it("sends the file in full again after it changed", async () => {
		const { harness, path, toolResults } = await createReadHarness();
		writeFileSync(path, "first version\n");

		await harness.session.prompt("read it");
		writeFileSync(path, "second version\n");
		await harness.session.prompt("read it again");

		expect(toolResults[1]).toEqual(["first version\n", "second version\n"]);
	});

	it("keeps a read of part of a file in full", async () => {
		const { harness, path, toolResults } = await createReadHarness({ offset: 2 });
		writeFileSync(path, "line one\nline two\n");

		await harness.session.prompt("read it");
		await harness.session.prompt("read it again");

		expect(toolResults[1]).toEqual(["line two\n", "line two\n"]);
	});
});
