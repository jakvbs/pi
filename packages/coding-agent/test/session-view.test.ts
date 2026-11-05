import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
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

function header(cwd: string, id = "view-test"): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-05T00:00:00.000Z", cwd });
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
	model = { provider: "anthropic", id: "claude-test" },
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
			provider: model.provider,
			model: model.id,
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

	it("reloads a file rewritten in place to a larger different session, keeping its header", () => {
		const dir = tempDir();
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${header(dir, "old")}\n${userEntry("u1", null, "old")}\n`);
		const tail = new SessionFileTail(file);
		tail.readAll();

		writeFileSync(
			file,
			`${header(dir, "new")}\n${userEntry("b1", null, "x")}\n${userEntry("b2", "b1", "y")}\n${userEntry("b3", "b2", "z")}\n`,
		);
		const read = tail.read();

		expect(read.type).toBe("reload");
		expect(read.type === "reload" && read.entries.map((entry) => entry.id)).toEqual(["new", "b1", "b2", "b3"]);
		expect(tail.read()).toEqual({ type: "none" });
	});

	it("reloads a file replaced by another one with the same header", () => {
		const dir = tempDir();
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${header(dir)}\n${userEntry("u1", null, "a")}\n`);
		const tail = new SessionFileTail(file);
		tail.readAll();

		writeFileSync(
			join(dir, "next.tmp"),
			`${header(dir)}\n${userEntry("v1", null, "b")}\n${userEntry("v2", "v1", "c")}\n`,
		);
		renameSync(join(dir, "next.tmp"), file);

		expect(tail.read()).toMatchObject({ type: "reload", entries: [{ type: "session" }, { id: "v1" }, { id: "v2" }] });
	});

	it("keeps the file's own header when the file is truncated and refilled", () => {
		const dir = tempDir();
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${header(dir, "keep")}\n${userEntry("u1", null, "a")}\n`);
		const tail = new SessionFileTail(file);
		const sessionManager = SessionManager.view(file, tail.readAll());

		truncateSync(file, 0);
		expect(tail.read()).toEqual({ type: "none" });
		writeFileSync(file, `${header(dir, "keep")}\n${userEntry("u2", null, "b")}\n`);
		const read = tail.read();

		expect(read).toMatchObject({ type: "reload", entries: [{ type: "session", id: "keep" }, { id: "u2" }] });
		if (read.type === "reload") sessionManager.reloadFileEntries(read.entries);
		expect(sessionManager.getSessionId()).toBe("keep");
		expect(sessionManager.getBranch().map((entry) => entry.id)).toEqual(["u2"]);
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

/** Open `file` the way `pi --view` does: no extensions or resources, the settings and models in `agentDir`. */
async function openView(file: string, agentDir: string) {
	initTheme("dark");
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
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	const terminal = new VirtualTerminal(120, 40);
	const mode = new InteractiveMode(runtime, { terminal, tuiMode: "regular", viewTail: tail });
	return { mode, runtime, terminal };
}

describe("InteractiveMode session view", () => {
	it("follows the writer: the turn stays open while it runs and folds when its reply arrives; typed prompts are ignored", async () => {
		const dir = tempDir();
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		const file = join(dir, "worker.jsonl");
		const initial = [
			header(dir),
			userEntry("u1", null, "Please list the files"),
			assistantEntry("a1", "u1", [
				{ type: "text", text: "Listing them now." },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
			]),
		];
		writeFileSync(file, `${initial.join("\n")}\n`);

		const { mode, runtime, terminal } = await openView(file, agentDir);
		const screen = () => terminal.getViewport().map((row) => row.trimEnd());

		try {
			await mode.init();
			await terminal.waitForRender();
			const before = screen();
			expect(before.join("\n")).toContain("Read-only view of worker.jsonl, following new entries");
			const taskRow = before.findIndex((row) => row.includes("Please list the files"));
			expect(before.join("\n")).toContain("Listing them now.");
			expect(before.join("\n")).toContain("bash ls");

			// The result arrives in a later write; it completes the call rendered earlier and the turn stays open.
			appendFileSync(file, `${toolResultEntry("t1", "a1", "call-1", "alpha.txt")}\n`);
			await vi.waitFor(() => expect(screen().find((row) => row.includes("bash ls"))).toContain("✓"), {
				timeout: 2000,
			});

			appendFileSync(file, `${assistantEntry("a2", "t1", [{ type: "text", text: "There is one file." }])}\n`);
			await vi.waitFor(() => expect(screen().join("\n")).toContain("There is one file."), { timeout: 2000 });

			const after = screen();
			// The task row keeps its place; the activity below it folds into one row above the reply.
			expect(after[taskRow]).toBe(before[taskRow]);
			const rows = after.slice(taskRow).filter((row) => row.trim());
			expect(rows.slice(0, 3).map((row) => row.trim())).toEqual([
				"Please list the files",
				"▸ 1 tool · 0:00",
				"There is one file.",
			]);
			expect(after.join("\n")).not.toContain("bash ls");

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

	it("names the session's own model in the footer when its provider is not loaded", async () => {
		const dir = tempDir();
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		const file = join(dir, "worker.jsonl");
		const thinking = JSON.stringify({
			type: "thinking_level_change",
			id: "k1",
			parentId: "u1",
			timestamp: "2026-11-05T00:00:01.500Z",
			thinkingLevel: "high",
		});
		const reply = assistantEntry("a1", "k1", [{ type: "text", text: "Done." }], {
			provider: "pi-sub-anthropic",
			id: "claude-opus-5-5",
		});
		writeFileSync(file, `${[header(dir), userEntry("u1", null, "hi"), thinking, reply].join("\n")}\n`);
		const { mode, runtime, terminal } = await openView(file, agentDir);

		try {
			await mode.init();
			await terminal.waitForRender();
			const footer = terminal.getViewport().join("\n");
			expect(footer).toContain("pi-sub-anthropic/claude-opus-5-5 • high");
			expect(footer).toContain("view-test");
		} finally {
			mode.stop();
			await runtime.dispose();
		}
	});

	it("writes no settings when it opens a session that has only its header", async () => {
		const dir = tempDir();
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		const file = join(dir, "new.jsonl");
		writeFileSync(file, `${header(dir)}\n`);
		const { mode, runtime, terminal } = await openView(file, agentDir);

		try {
			await mode.init();
			await terminal.waitForRender();
			const screen = terminal.getViewport().join("\n");
			expect(screen).toContain("Read-only view of new.jsonl");
			// The startup header names only keys that work in a view.
			expect(screen).not.toContain("commands");
			expect(screen).not.toContain("bash");
			expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
		} finally {
			mode.stop();
			await runtime.dispose();
		}
	});

	it("shows the new session when the writer rewrites the file to a larger different one", async () => {
		const dir = tempDir();
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		const file = join(dir, "worker.jsonl");
		writeFileSync(file, `${header(dir, "old")}\n${userEntry("o1", null, "Old question")}\n`);
		const { mode, runtime, terminal } = await openView(file, agentDir);

		try {
			await mode.init();
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("Old question");

			const rewritten = [
				header(dir, "new"),
				userEntry("n1", null, "New question"),
				assistantEntry("n2", "n1", [{ type: "text", text: "New answer." }]),
				userEntry("n3", "n2", "New follow-up"),
			];
			writeFileSync(file, `${rewritten.join("\n")}\n`);
			await vi.waitFor(() => expect(terminal.getViewport().join("\n")).toContain("New follow-up"), {
				timeout: 2000,
			});

			const screen = terminal.getViewport().join("\n");
			expect(screen).not.toContain("Old question");
			expect(screen).toContain("New answer.");
			expect(runtime.session.sessionManager.getSessionId()).toBe("new");
			expect(runtime.session.sessionManager.getBranch().map((entry) => entry.id)).toEqual(["n1", "n2", "n3"]);
		} finally {
			mode.stop();
			await runtime.dispose();
		}
	});
});
