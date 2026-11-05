import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { openSessionFileTail, SessionFileTail } from "../src/core/session-file-tail.ts";
import { type FileEntry, SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-view-"));
	tempDirs.push(dir);
	return dir;
}

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function header(cwd: string): string {
	return JSON.stringify({ type: "session", version: 3, id: "view-test", timestamp: "2026-11-05T00:00:00.000Z", cwd });
}

function userEntry(id: string, parentId: string | null, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-05T00:00:01.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	});
}

function assistantEntry(
	id: string,
	parentId: string,
	content: Array<
		| { type: "text"; text: string }
		| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	>,
): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-05T00:00:02.000Z",
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage,
			stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
			timestamp: 2,
		},
	});
}

function toolResultEntry(id: string, parentId: string, toolCallId: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-05T00:00:03.000Z",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 3,
		},
	});
}

describe("SessionFileTail", () => {
	it("reads only whole lines and never writes to the file", () => {
		const dir = tempDir();
		const file = join(dir, "s.jsonl");
		const firstUser = userEntry("u1", null, "first");
		writeFileSync(file, `${header(dir)}\n${firstUser.slice(0, 20)}`);
		const tail = new SessionFileTail(file);

		expect(tail.readAll().map((entry) => entry.type)).toEqual(["session"]);
		appendFileSync(file, `${firstUser.slice(20)}\n`);
		const read = tail.read();

		expect(read).toMatchObject({ type: "append", continuesLeaf: true, entries: [{ id: "u1" }] });
		expect(tail.read()).toEqual({ type: "none" });
		expect(readFileSync(file, "utf8")).toBe(`${header(dir)}\n${firstUser}\n`);
	});

	it("tells whether new entries continue the last entry it read", () => {
		const dir = tempDir();
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${header(dir)}\n${userEntry("u1", null, "a")}\n${userEntry("u2", "u1", "b")}\n`);
		const tail = new SessionFileTail(file);
		tail.readAll();

		appendFileSync(file, `${userEntry("u3", "u1", "branch")}\n`);

		expect(tail.read()).toMatchObject({ type: "append", continuesLeaf: false });
	});

	it("reloads every entry when the file shrank", () => {
		const dir = tempDir();
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${header(dir)}\n${userEntry("u1", null, "a long first message")}\n`);
		const tail = new SessionFileTail(file);
		tail.readAll();

		writeFileSync(file, `${header(dir)}\n${userEntry("u9", null, "short")}\n`);
		const read = tail.read();

		expect(read.type).toBe("reload");
		expect(read.type === "reload" && read.entries.map((entry: FileEntry) => entry.type)).toEqual([
			"session",
			"message",
		]);
	});

	it("waits for a directory's newest session file", async () => {
		const dir = join(tempDir(), "later");
		const onWait = vi.fn();
		const opened = openSessionFileTail(dir, onWait);
		await new Promise((resolve) => setTimeout(resolve, 50));
		mkdirSync(dir);
		writeFileSync(join(dir, "old.jsonl"), `${header(dir)}\n`);
		writeFileSync(join(dir, "notes.txt"), "not a session");

		const { tail, entries } = await opened;

		expect(onWait).toHaveBeenCalledTimes(1);
		expect(tail.path).toBe(join(dir, "old.jsonl"));
		expect(entries).toHaveLength(1);
	});
});

describe("InteractiveMode session view", () => {
	it("appends entries the writer adds below the rows already shown and ignores typed prompts", async () => {
		initTheme("dark");
		const dir = tempDir();
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		const file = join(dir, "worker.jsonl");
		const initial = [
			header(dir),
			userEntry("u1", null, "Please list the files"),
			assistantEntry("a1", "u1", [{ type: "text", text: "Listing them now." }]),
		];
		writeFileSync(file, `${initial.join("\n")}\n`);

		const { tail, entries } = await openSessionFileTail(file, () => {});
		const sessionManager = SessionManager.view(tail.path, entries);
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: join(agentDir, "models.json"),
		});
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
			return { ...created, services, diagnostics: services.diagnostics };
		};
		const runtime = await createAgentSessionRuntime(createRuntime, { cwd: dir, agentDir, sessionManager });
		const terminal = new VirtualTerminal(100, 40);
		const mode = new InteractiveMode(runtime, { terminal, tuiMode: "regular", viewTail: tail });

		try {
			await mode.init();
			await terminal.waitForRender();
			const before = terminal.getViewport().map((row) => row.trimEnd());
			expect(before.join("\n")).toContain("Please list the files");
			expect(before.join("\n")).toContain("Listing them now.");
			expect(before.join("\n")).toContain("Read-only view of worker.jsonl, following new entries");

			// The writer appends a tool call, then its result in a later write, then the reply.
			appendFileSync(
				file,
				`${assistantEntry("a2", "a1", [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }])}\n`,
			);
			await vi.waitFor(() => expect(terminal.getViewport().join("\n")).toContain("bash ls"), { timeout: 2000 });
			appendFileSync(file, `${toolResultEntry("t1", "a2", "call-1", "alpha.txt")}\n`);
			appendFileSync(file, `${assistantEntry("a3", "t1", [{ type: "text", text: "There is one file." }])}\n`);
			await vi.waitFor(() => expect(terminal.getViewport().join("\n")).toContain("There is one file."), {
				timeout: 2000,
			});

			const after = terminal.getViewport().map((row) => row.trimEnd());
			const firstRow = after.findIndex((row) => row.includes("Please list the files"));
			// The rows shown before the append stay in place, in order, and the new ones follow them.
			expect(after.slice(firstRow, firstRow + 3)).toEqual(
				before.slice(
					before.findIndex((row) => row.includes("Please list the files")),
					before.findIndex((row) => row.includes("Please list the files")) + 3,
				),
			);
			const toolRow = after.findIndex((row) => row.includes("bash ls"));
			expect(toolRow).toBeGreaterThan(after.findIndex((row) => row.includes("Listing them now.")));
			// The result arrived in a later write and still completed the call rendered earlier.
			expect(after[toolRow]).toContain("✓");
			expect(after.findIndex((row) => row.includes("There is one file."))).toBeGreaterThan(toolRow);

			const bytes = readFileSync(file);
			terminal.sendInput("hello from the viewer");
			terminal.sendInput("\r");
			await new Promise((resolve) => setTimeout(resolve, 400));
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).not.toContain("hello from the viewer");
			expect(runtime.session.isStreaming).toBe(false);
			expect(readFileSync(file).equals(bytes)).toBe(true);
		} finally {
			mode.stop();
			await runtime.dispose();
		}
	});
});
