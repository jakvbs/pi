import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { processFileArguments } from "../../src/cli/file-processor.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("repeated whole-file reads", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	/**
	 * A harness whose model reads `path` with `args` on every prompt; returns the tool results each request carried.
	 * `contextFile` is loaded into the system prompt as a context file.
	 */
	async function createReadHarness(
		args: { offset?: number; limit?: number } = {},
		contextFile?: { path: string; content: string },
	) {
		const dir = mkdtempSync(join(tmpdir(), "pi-repeated-read-"));
		tempDirs.push(dir);
		const path = contextFile?.path ?? join(dir, "notes.md");
		const resourceLoader = {
			...createTestResourceLoader(),
			getAgentsFiles: () => ({ agentsFiles: contextFile ? [contextFile] : [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
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

	it("sends a read of a context file that matches the system prompt as a note", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-context-file-"));
		tempDirs.push(dir);
		const path = join(dir, "AGENTS.md");
		writeFileSync(path, "# Rules\n\nRun the tests.\n");
		const { harness, toolResults } = await createReadHarness({}, { path, content: "# Rules\n\nRun the tests.\n" });

		await harness.session.prompt("read the rules");

		expect(toolResults[0]).toEqual([
			`${path} has not changed. Its full content is in the system prompt as project instructions.`,
		]);
	});

	it("sends a context file in full when it changed after the system prompt loaded it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-context-file-"));
		tempDirs.push(dir);
		const path = join(dir, "AGENTS.md");
		writeFileSync(path, "# Rules\n\nRun the new tests.\n");
		const { harness, toolResults } = await createReadHarness({}, { path, content: "# Rules\n\nRun the tests.\n" });

		await harness.session.prompt("read the rules");

		expect(toolResults[0]).toEqual(["# Rules\n\nRun the new tests.\n"]);
	});

	it("sends a read of a file given with @path as a note", async () => {
		const { harness, path, toolResults } = await createReadHarness();
		writeFileSync(path, "line one\nline two\n");
		const { text } = await processFileArguments([path]);

		await harness.session.prompt(`${text}fix it`);

		expect(toolResults[0]).toEqual([
			`${path} has not changed since its full content last appeared earlier in this conversation. Use that content.`,
		]);
	});
});
