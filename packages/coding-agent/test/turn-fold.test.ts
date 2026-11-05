import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { TURN_HANDOFF_ENTRY_TYPE } from "../src/core/turn-handoff.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { TranscriptContainer } from "../src/modes/interactive/components/tool-execution.ts";
import { TurnFolds } from "../src/modes/interactive/components/turn-fold.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const START = Date.UTC(2026, 10, 5, 12, 0, 0);

type ModeThis = Record<string, unknown> & { chatContainer: TranscriptContainer; turnFolds: TurnFolds };

/** The parts of InteractiveMode that render a branch and handle run events, with the real methods. */
function createMode(
	options: { folding?: boolean; isStreaming?: boolean; showCacheMissNotices?: boolean; view?: boolean } = {},
): ModeThis {
	const chatContainer = new TranscriptContainer();
	const prototype = InteractiveMode.prototype as unknown as Record<string, unknown>;
	const mode: ModeThis = {
		chatContainer,
		turnFolds: new TurnFolds(chatContainer, options.folding ?? true, 1),
		// A view only checks that it follows a file; it never reads it here.
		options: { viewTail: options.view ? {} : undefined },
		pendingTools: new Map<string, ToolExecutionComponent>(),
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		toolDisplayMode: "compact",
		toolOutputExpanded: false,
		isInitialized: true,
		workingVisible: true,
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } } as unknown as TUI,
		editor: { addToHistory: vi.fn() },
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowCacheMissNotices: () => options.showCacheMissNotices ?? false,
			getShowTerminalProgress: () => false,
		},
		sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
		session: {
			retryAttempt: 0,
			isStreaming: options.isStreaming ?? false,
			extensionRunner: {
				getMessageRenderer: () => undefined,
				// An extension that runs every `!` command itself, so the test needs no shell.
				emitUserBash: async () => ({ result: { output: "ok", exitCode: 0, cancelled: false, truncated: false } }),
			},
			recordBashResult: vi.fn(),
		},
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		getRegisteredToolDefinition: () => undefined,
		updateEditorBorderColor: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		clearStatusIndicator: vi.fn(),
		maybeShowThinkingDropNotice: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
		maybeSuggestBugReport: vi.fn(),
		maybeShowInstallChangeWarning: vi.fn(),
	};
	for (const name of [
		"renderSessionEntries",
		"renderSessionItems",
		"appendSessionEntries",
		"addMessageToChat",
		"renderMessage",
		"getUserMessageText",
		"handleEvent",
		"addCompactionMarker",
		"addCompactionCostNotice",
		"showError",
		"handleBashCommand",
		"addBashComponentToChat",
		"addCustomEntryToChat",
	]) {
		mode[name] = prototype[name];
	}
	return mode;
}

function renderBranch(mode: ModeThis, messages: BranchItem[]): void {
	(mode.renderSessionEntries as (this: ModeThis, entries: SessionEntry[]) => void).call(mode, toEntries(messages));
}

/** Show messages the writer added to a viewed file below the rows already shown. */
function appendBranch(mode: ModeThis, messages: AgentMessage[], firstIndex: number): void {
	const entries = toEntries(messages, firstIndex);
	(mode.appendSessionEntries as (this: ModeThis, entries: SessionEntry[]) => void).call(mode, entries);
}

/** A message, or the data of a turn handoff entry an extension appended. */
type BranchItem = AgentMessage | { handoff: unknown };

function toEntries(items: BranchItem[], firstIndex = 0): SessionEntry[] {
	let parentId: string | null = firstIndex > 0 ? `entry-${firstIndex - 1}` : null;
	return items.map((item, offset): SessionEntry => {
		const base = { id: `entry-${firstIndex + offset}`, parentId, timestamp: new Date(START).toISOString() };
		const entry: SessionEntry =
			"handoff" in item
				? { ...base, type: "custom", customType: TURN_HANDOFF_ENTRY_TYPE, data: item.handoff }
				: { ...base, type: "message", message: item };
		parentId = entry.id;
		return entry;
	});
}

/** Append a turn handoff entry while the session runs, as `pi.appendEntry` does. */
async function appendHandoff(mode: ModeThis, handoff: unknown): Promise<void> {
	const entry: SessionEntry = {
		type: "custom",
		customType: TURN_HANDOFF_ENTRY_TYPE,
		data: handoff,
		id: "handoff",
		parentId: null,
		timestamp: new Date(START).toISOString(),
	};
	await emit(mode, { type: "entry_appended", entry });
}

const RUNNING = { kind: "running", goal: "Fix the login bug.", done: "Read src/auth.ts.", next: "Run the tests." };
const FINISHED = { kind: "finished", summary: "Fixed the token check in src/auth.ts; the tests pass." };

async function emit(mode: ModeThis, event: AgentSessionEvent): Promise<void> {
	await (mode.handleEvent as (this: ModeThis, event: AgentSessionEvent) => Promise<void>).call(mode, event);
}

function visibleLines(mode: ModeThis): string[] {
	return mode.chatContainer
		.render(100)
		.map((line) => stripAnsi(line).trim())
		.filter(Boolean);
}

function click(mode: ModeThis, row: string): void {
	const y = mode.chatContainer.render(100).findIndex((line) => stripAnsi(line).trim() === row);
	expect(y).toBeGreaterThanOrEqual(0);
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width: 100,
		height: 1000,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	expect(mode.chatContainer.handleMouse(event)?.handled).toBe(true);
}

const user = (text: string, at: number): AgentMessage => ({ role: "user", content: text, timestamp: START + at });

function assistant(
	content: Parameters<typeof fauxAssistantMessage>[0],
	at: number,
	durationMs: number,
	stopReason: AssistantMessage["stopReason"] = "toolUse",
	errorMessage?: string,
): AssistantMessage {
	return { ...fauxAssistantMessage(content, { stopReason, errorMessage, timestamp: START + at }), durationMs };
}

function toolResult(toolCallId: string, text: string, isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp: START,
	};
}

/** Run one bash tool call to its end, finishing at `finishedAt` on the wall clock. */
async function runTool(
	mode: ModeThis,
	id: string,
	command: string,
	finishedAt: number,
	isError = false,
): Promise<void> {
	await emit(mode, { type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } });
	vi.setSystemTime(START + finishedAt);
	await emit(mode, {
		type: "tool_execution_end",
		toolCallId: id,
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }], details: undefined },
		isError,
	});
}

/** Show a finished assistant message, as a live run does. */
async function respond(mode: ModeThis, message: AssistantMessage): Promise<void> {
	await emit(mode, { type: "message_start", message });
	await emit(mode, { type: "message_end", message });
}

/** Two turns: one that read, ran a failing command and thought, and one that only answered. */
const RECORDED_BRANCH: AgentMessage[] = [
	user("fix the bug", 0),
	assistant(
		[fauxThinking("look at the file"), fauxToolCall("read", { path: "src/a.ts" }, { id: "t1" })],
		1_000,
		2_000,
	),
	toolResult("t1", "file body", false),
	assistant(
		[fauxText("running the tests"), fauxToolCall("bash", { command: "npm test" }, { id: "t2" })],
		5_000,
		1_000,
	),
	toolResult("t2", "1 failed", true),
	assistant([fauxThinking("the test needs a fix"), fauxText("Fixed it.")], 90_000, 10_000, "stop"),
	user("thanks", 200_000),
	assistant("You are welcome.", 201_000, 1_000, "stop"),
];

describe("TurnFolds", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("folds a recorded branch into user message, one row and the reply", () => {
		const mode = createMode();
		renderBranch(mode, RECORDED_BRANCH);

		expect(visibleLines(mode)).toEqual([
			"fix the bug",
			"▸ 2 tools · 2 thinking · 1:40 · 1 error",
			"Fixed it.",
			"thanks",
			"You are welcome.",
		]);
	});

	test("a click opens one row with the whole activity and the reply's thinking, a second click folds it", () => {
		const mode = createMode();
		renderBranch(mode, RECORDED_BRANCH);

		click(mode, "▸ 2 tools · 2 thinking · 1:40 · 1 error");
		expect(visibleLines(mode)).toEqual([
			"fix the bug",
			"▾ 2 tools · 2 thinking · 1:40 · 1 error",
			"look at the file",
			"✓ read src/a.ts",
			"running the tests",
			"✗ bash npm test",
			"the test needs a fix",
			"Fixed it.",
			"thanks",
			"You are welcome.",
		]);

		click(mode, "▾ 2 tools · 2 thinking · 1:40 · 1 error");
		expect(visibleLines(mode)).toContain("▸ 2 tools · 2 thinking · 1:40 · 1 error");
		expect(visibleLines(mode)).not.toContain("look at the file");
	});

	test("the toggle key opens the last row; folding off shows every turn in full without rows", () => {
		const mode = createMode();
		renderBranch(mode, RECORDED_BRANCH);

		expect(mode.turnFolds.toggleLast()).toBe(true);
		expect(visibleLines(mode)[1]).toBe("▾ 2 tools · 2 thinking · 1:40 · 1 error");

		mode.turnFolds.setFolding(false);
		const full = visibleLines(mode);
		expect(full).toEqual([
			"fix the bug",
			"look at the file",
			"✓ read src/a.ts",
			"running the tests",
			"✗ bash npm test",
			"the test needs a fix",
			"Fixed it.",
			"thanks",
			"You are welcome.",
		]);
		expect(mode.turnFolds.toggleLast()).toBe(false);

		mode.turnFolds.setFolding(true);
		expect(visibleLines(mode)[1]).toBe("▸ 2 tools · 2 thinking · 1:40 · 1 error");
	});

	test("an aborted turn folds and keeps its abort text below the row", () => {
		const mode = createMode();
		renderBranch(mode, [
			user("refactor", 0),
			assistant([fauxThinking("plan"), fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 0, 3_000, "aborted"),
			user("go on", 10_000),
		]);

		expect(visibleLines(mode)).toEqual([
			"refactor",
			"▸ 1 tool · 1 thinking · 0:03 · 1 error",
			"Operation aborted",
			"go on",
		]);
	});

	test("a compaction folds the running turn's first part; a branch that ends in a running turn folds what it finished", async () => {
		const mode = createMode({ isStreaming: true });
		renderBranch(mode, [
			user("long task", 0),
			assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 0, 1_000),
			toolResult("t1", "ok", false),
			{ role: "compactionSummary", summary: "summary", tokensBefore: 10, timestamp: START + 2_000 },
			assistant([fauxToolCall("bash", { command: "pwd" }, { id: "t2" })], 3_000, 1_000),
			toolResult("t2", "ok", false),
		]);

		const live = visibleLines(mode);
		expect(live[1]).toBe("▸ 1 tool · 0:01");
		expect(live.at(-1)).toBe("▸ 1 tool · 0:02");
		expect(live).not.toContain("✓ bash pwd");

		await respond(mode, assistant("Done.", 5_000, 1_000, "stop"));
		expect(visibleLines(mode).slice(-2)).toEqual(["▸ 1 tool · 0:04", "Done."]);
	});

	test("a running turn folds each finished row at once; the running call and the response being written show below", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const mode = createMode();
		const step = assistant(
			[fauxThinking("list the files"), fauxText("Listing."), fauxToolCall("bash", { command: "ls" }, { id: "t1" })],
			1_000,
			1_000,
		);

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("check", 0) });
		await respond(mode, step);
		await emit(mode, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
		expect(visibleLines(mode)).toEqual(["check", "▸ 1 thinking · 0:02", "… bash ls"]);

		await runTool(mode, "t1", "ls", 3_000);
		const writing = assistant([fauxThinking("all files are there"), fauxText("All")], 4_000, 0, "stop");
		await emit(mode, { type: "message_start", message: writing });
		expect(visibleLines(mode)).toEqual(["check", "▸ 1 tool · 1 thinking · 0:03", "Thinking...", "All"]);

		await emit(mode, {
			type: "message_end",
			message: assistant([fauxThinking("all files are there"), fauxText("All good.")], 4_000, 1_000, "stop"),
		});
		expect(visibleLines(mode)).toEqual(["check", "▸ 1 tool · 2 thinking · 0:05", "All good."]);

		mode.turnFolds.toggleLast();
		expect(visibleLines(mode)).toEqual([
			"check",
			"▾ 1 tool · 2 thinking · 0:05",
			"list the files",
			"Listing.",
			"✓ bash ls",
			"all files are there",
			"All good.",
		]);
	});

	test("a running turn opened by the toggle key stays open at its reply; with folding off it shows in full", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const mode = createMode();

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("check", 0) });
		await respond(mode, assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 1_000, 1_000));
		await runTool(mode, "t1", "ls", 2_000);
		expect(mode.turnFolds.toggleLast()).toBe(true);
		await respond(mode, assistant("Done.", 3_000, 1_000, "stop"));
		expect(visibleLines(mode)).toEqual(["check", "▾ 1 tool · 0:04", "✓ bash ls", "Done."]);

		const full = createMode({ folding: false });
		await emit(full, { type: "agent_start" });
		await emit(full, { type: "message_start", message: user("check", 0) });
		await respond(full, assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 1_000, 1_000));
		await runTool(full, "t1", "ls", 2_000);
		await emit(full, { type: "message_start", message: assistant([fauxThinking("done")], 3_000, 0, "stop") });
		expect(visibleLines(full)).toEqual(["check", "✓ bash ls", "done"]);
	});

	test("a finished run folds its turn at the reply; a turn without tools or thinking gets no row", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const mode = createMode();

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("check", 0) });
		await respond(mode, assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 1_000, 1_000));
		await runTool(mode, "t1", "ls", 2_500);
		await respond(mode, assistant("All good.", 3_000, 2_000, "stop"));
		expect(visibleLines(mode)).toEqual(["check", "▸ 1 tool · 0:05", "All good."]);
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("hi", 10_000) });
		await respond(mode, assistant("Hello.", 11_000, 1_000, "stop"));
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		expect(visibleLines(mode).slice(-2)).toEqual(["hi", "Hello."]);
	});

	test("a failed reply folds its turn; the automatic retry is a turn of its own", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const mode = createMode();

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("check", 0) });
		await respond(mode, assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 1_000, 1_000));
		await runTool(mode, "t1", "ls", 2_000, true);
		await respond(mode, assistant("", 2_000, 1_000, "error", "overloaded"));
		await emit(mode, { type: "agent_end", messages: [], willRetry: true });
		expect(visibleLines(mode)).toEqual(["check", "▸ 1 tool · 0:03 · 1 error", "Error: overloaded"]);

		await emit(mode, { type: "agent_start" });
		await respond(
			mode,
			assistant([fauxThinking("try again"), fauxToolCall("bash", { command: "pwd" }, { id: "t2" })], 10_000, 1_000),
		);
		await runTool(mode, "t2", "pwd", 12_000);
		await respond(mode, assistant("All good.", 12_000, 1_000, "stop"));
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		expect(visibleLines(mode)).toEqual([
			"check",
			"▸ 1 tool · 0:03 · 1 error",
			"Error: overloaded",
			"▸ 1 tool · 1 thinking · 0:03",
			"All good.",
		]);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("a displayed extension message during a run stays visible, and the run folds into one row", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const mode = createMode();
		const notice: AgentMessage = {
			role: "custom",
			customType: "web",
			content: "Content fetched",
			display: true,
			timestamp: START + 2_000,
		};

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("fetch it", 0) });
		await respond(mode, assistant([fauxToolCall("bash", { command: "curl a" }, { id: "t1" })], 0, 1_000));
		await runTool(mode, "t1", "curl a", 2_000);
		await emit(mode, { type: "message_start", message: notice });
		await respond(mode, assistant([fauxToolCall("bash", { command: "curl b" }, { id: "t2" })], 3_000, 1_000));
		await runTool(mode, "t2", "curl b", 5_000);
		await respond(mode, assistant("Done.", 6_000, 1_000, "stop"));
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		await emit(mode, { type: "message_start", message: user("next", 10_000) });

		expect(visibleLines(mode)).toEqual(["fetch it", "▸ 2 tools · 0:07", "[web]", "Content fetched", "Done.", "next"]);
	});

	test("an extension message after the reply starts a turn of its own, which folds at its reply", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const mode = createMode();
		const notice: AgentMessage = {
			role: "custom",
			customType: "web",
			content: "Content fetched",
			display: true,
			timestamp: START + 5_000,
		};

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("check", 0) });
		await respond(mode, assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 0, 1_000));
		await runTool(mode, "t1", "ls", 2_000);
		await respond(mode, assistant("Checked.", 2_000, 1_000, "stop"));
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		await emit(mode, { type: "message_start", message: notice });
		expect(visibleLines(mode)).toEqual(["check", "▸ 1 tool · 0:03", "Checked.", "[web]", "Content fetched"]);

		await emit(mode, { type: "agent_start" });
		await respond(mode, assistant([fauxThinking("read it"), fauxText("It says hi.")], 6_000, 1_000, "stop"));
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		expect(visibleLines(mode)).toEqual([
			"check",
			"▸ 1 tool · 0:03",
			"Checked.",
			"[web]",
			"Content fetched",
			"▸ 1 thinking · 0:02",
			"It says hi.",
		]);
	});

	test("a ! command shows below the folded turn", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const mode = createMode();

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("check", 0) });
		await respond(mode, assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 0, 1_000));
		await runTool(mode, "t1", "ls", 2_000);
		await respond(mode, assistant("Checked.", 2_000, 1_000, "stop"));
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });

		await (mode.handleBashCommand as (this: ModeThis, command: string) => Promise<void>).call(mode, "git status");
		const lines = visibleLines(mode);
		expect(lines.slice(0, 3)).toEqual(["check", "▸ 1 tool · 0:03", "Checked."]);
		expect(lines.join("\n")).toContain("$ git status");
	});

	test("a restored session folds every turn, the last one too", () => {
		const mode = createMode();
		renderBranch(mode, [
			...RECORDED_BRANCH,
			user("run it", 300_000),
			assistant([fauxToolCall("bash", { command: "npm run build" }, { id: "t3" })], 301_000, 1_000),
			toolResult("t3", "built", false),
			assistant("Built.", 303_000, 1_000, "stop"),
		]);

		expect(visibleLines(mode)).toEqual([
			"fix the bug",
			"▸ 2 tools · 2 thinking · 1:40 · 1 error",
			"Fixed it.",
			"thanks",
			"You are welcome.",
			"run it",
			"▸ 1 tool · 0:04",
			"Built.",
		]);
	});

	test("a steering message splits the run; the split part's duration runs to its last tool result", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const mode = createMode();

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("run tools", 0) });
		await respond(mode, assistant([fauxToolCall("bash", { command: "sleep 3" }, { id: "t1" })], 0, 0));
		await runTool(mode, "t1", "sleep 3", 3_000);
		await emit(mode, { type: "message_start", message: user("more tools", 3_500) });
		await respond(mode, assistant([fauxToolCall("bash", { command: "ls" }, { id: "t2" })], 4_000, 1_000));
		await runTool(mode, "t2", "ls", 5_500);
		await respond(mode, assistant("Done.", 6_000, 1_000, "stop"));
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		await emit(mode, { type: "message_start", message: user("next", 10_000) });

		expect(visibleLines(mode)).toEqual([
			"run tools",
			"▸ 1 tool · 0:03",
			"more tools",
			"▸ 1 tool · 0:04",
			"Done.",
			"next",
		]);
	});

	test("the compaction cost notice stays beside its marker, outside any fold", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const mode = createMode({ showCacheMissNotices: true });
		const usage = {
			input: 1_000,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_200,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("long task", 0) });
		await respond(mode, assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 0, 1_000));
		await runTool(mode, "t1", "ls", 2_000);
		(mode.addCompactionMarker as (this: ModeThis, compaction: object, timestamp: string) => void).call(
			mode,
			{ summary: "summary", tokensBefore: 10, usage },
			new Date(START + 2_000).toISOString(),
		);
		await respond(mode, assistant([fauxToolCall("bash", { command: "pwd" }, { id: "t2" })], 3_000, 1_000));
		await runTool(mode, "t2", "pwd", 4_500);
		await respond(mode, assistant("Done.", 5_000, 1_000, "stop"));
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		await emit(mode, { type: "message_start", message: user("next", 10_000) });

		const lines = visibleLines(mode);
		expect(lines.slice(0, 3)).toEqual(["long task", "▸ 1 tool · 0:02", "[compaction]"]);
		expect(lines.slice(-4)).toEqual(["Compaction: 1.2k tokens billed", "▸ 1 tool · 0:04", "Done.", "next"]);
	});
});

describe("Turn handoffs", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("a running handoff shows in three lines below the running turn's row; the reply removes it", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const mode = createMode();

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("fix the login", 0) });
		await respond(mode, assistant([fauxToolCall("bash", { command: "cat src/auth.ts" }, { id: "t1" })], 0, 1_000));
		await runTool(mode, "t1", "cat src/auth.ts", 2_000);
		await appendHandoff(mode, RUNNING);
		expect(visibleLines(mode)).toEqual([
			"fix the login",
			"▸ 1 tool · 0:02",
			"◇ Fix the login bug.",
			"✓ Read src/auth.ts.",
			"→ Run the tests.",
		]);

		await respond(mode, assistant("Fixed.", 3_000, 1_000, "stop"));
		expect(visibleLines(mode)).toEqual(["fix the login", "▸ 1 tool · 0:04", "Fixed."]);
	});

	test("a finished handoff follows the counts in the last folded row, also after the next message; open, it shows in full", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const mode = createMode();

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("fix the login", 0) });
		await respond(mode, assistant([fauxToolCall("bash", { command: "cat src/auth.ts" }, { id: "t1" })], 0, 1_000));
		await runTool(mode, "t1", "cat src/auth.ts", 2_000);
		await respond(mode, assistant("Fixed.", 3_000, 1_000, "stop"));
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		await emit(mode, { type: "message_start", message: user("thanks", 10_000) });
		await appendHandoff(mode, FINISHED);
		expect(visibleLines(mode)).toEqual([
			"fix the login",
			"▸ 1 tool · 0:04 · Fixed the token check in src/auth.ts; the tests pass.",
			"Fixed.",
			"thanks",
		]);

		const narrow = mode.chatContainer.render(40).map((line) => stripAnsi(line).trim());
		expect(narrow).toContain("▸ 1 tool · 0:04 · Fixed the token ch...");
		expect(mode.turnFolds.toggleLast()).toBe(true);
		expect(visibleLines(mode).slice(0, 4)).toEqual([
			"fix the login",
			"▾ 1 tool · 0:04",
			"Fixed the token check in src/auth.ts; the tests pass.",
			"✓ bash cat src/auth.ts",
		]);
	});

	test("a loaded branch shows its handoffs as the live session did; data that is not a handoff shows nothing", () => {
		const mode = createMode();
		renderBranch(mode, [
			user("fix the login", 0),
			assistant([fauxToolCall("bash", { command: "cat src/auth.ts" }, { id: "t1" })], 0, 1_000),
			toolResult("t1", "ok", false),
			{ handoff: RUNNING },
			assistant("Fixed.", 3_000, 1_000, "stop"),
			{ handoff: FINISHED },
			user("go on", 10_000),
			assistant([fauxToolCall("bash", { command: "npm test" }, { id: "t2" })], 10_000, 1_000),
			toolResult("t2", "ok", false),
			{ handoff: { ...RUNNING, done: "Ran npm test." } },
			{ handoff: { kind: "running", goal: "No other fields." } },
		]);

		expect(visibleLines(mode)).toEqual([
			"fix the login",
			"▸ 1 tool · 0:04 · Fixed the token check in src/auth.ts; the tests pass.",
			"Fixed.",
			"go on",
			"▸ 1 tool · 0:01",
			"◇ Fix the login bug.",
			"✓ Ran npm test.",
			"→ Run the tests.",
		]);
	});
});

describe("TurnFolds in a read-only view", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	/** A finished worker session: one task, its activity and the final reply. */
	const WORKER_SESSION = RECORDED_BRANCH.slice(0, 6);

	test("a finished one-turn worker session reads as task, one row and reply, as in a normal session", () => {
		const view = createMode({ view: true });
		renderBranch(view, WORKER_SESSION);
		expect(visibleLines(view)).toEqual(["fix the bug", "▸ 2 tools · 2 thinking · 1:40 · 1 error", "Fixed it."]);

		const normal = createMode();
		renderBranch(normal, WORKER_SESSION);
		expect(visibleLines(normal)).toEqual(visibleLines(view));

		expect(view.turnFolds.toggleLast()).toBe(true);
		expect(visibleLines(view)).toContain("✗ bash npm test");
	});

	/** Rows after loading a file at once, and after following it while the writer adds one entry at a time. */
	function loadedAndFollowed(messages: AgentMessage[]): { loaded: string[]; followed: string[] } {
		const loaded = createMode({ view: true });
		renderBranch(loaded, messages);
		const followed = createMode({ view: true });
		renderBranch(followed, messages.slice(0, 1));
		for (let i = 1; i < messages.length; i++) appendBranch(followed, [messages[i]], i);
		return { loaded: visibleLines(loaded), followed: visibleLines(followed) };
	}

	test("a retry after a failed reply is a turn of its own, on load as when followed", () => {
		const { loaded, followed } = loadedAndFollowed([
			user("check", 0),
			assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 0, 1_000),
			toolResult("t1", "ok", false),
			assistant("Listed.", 2_000, 1_000, "stop"),
			assistant([fauxThinking("look again")], 10_000, 1_000, "error", "overloaded"),
			assistant([fauxToolCall("bash", { command: "pwd" }, { id: "t2" })], 20_000, 1_000),
			toolResult("t2", "ok", false),
			assistant("Checked.", 22_000, 1_000, "stop"),
		]);
		expect(loaded).toEqual([
			"check",
			"▸ 1 tool · 0:03",
			"Listed.",
			"▸ 1 thinking · 0:01",
			"Error: overloaded",
			"▸ 1 tool · 0:03",
			"Checked.",
		]);
		expect(followed).toEqual(loaded);
	});

	test("a run a hidden extension message restarts after the reply is a turn of its own, on load as when followed", () => {
		const noteCheck: AgentMessage = {
			role: "custom",
			customType: "limen-note-check",
			content: "Check the note.",
			display: false,
			timestamp: START + 5_000,
		};
		const { loaded, followed } = loadedAndFollowed([
			user("fix the bug", 0),
			assistant([fauxToolCall("bash", { command: "npm test" }, { id: "t1" })], 0, 1_000),
			toolResult("t1", "1 failed", true),
			assistant("Fixed it.", 2_000, 1_000, "stop"),
			noteCheck,
			assistant([fauxToolCall("bash", { command: "cat note.md" }, { id: "t2" })], 10_000, 1_000),
			toolResult("t2", "ok", false),
			assistant("Note updated.", 12_000, 1_000, "stop"),
		]);
		expect(loaded).toEqual([
			"fix the bug",
			"▸ 1 tool · 0:03 · 1 error",
			"Fixed it.",
			"▸ 1 tool · 0:03",
			"Note updated.",
		]);
		expect(followed).toEqual(loaded);
	});
});
