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
	]) {
		mode[name] = prototype[name];
	}
	return mode;
}

function renderBranch(mode: ModeThis, messages: AgentMessage[]): void {
	(mode.renderSessionEntries as (this: ModeThis, entries: SessionEntry[]) => void).call(mode, toEntries(messages));
}

/** Show messages the writer added to a viewed file below the rows already shown. */
function appendBranch(mode: ModeThis, messages: AgentMessage[], firstIndex: number): void {
	const entries = toEntries(messages, firstIndex);
	(mode.appendSessionEntries as (this: ModeThis, entries: SessionEntry[]) => void).call(mode, entries);
}

function toEntries(messages: AgentMessage[], firstIndex = 0): SessionEntry[] {
	let parentId: string | null = firstIndex > 0 ? `entry-${firstIndex - 1}` : null;
	return messages.map((message, offset): SessionEntry => {
		const entry: SessionEntry = {
			type: "message",
			id: `entry-${firstIndex + offset}`,
			parentId,
			timestamp: new Date(START).toISOString(),
			message,
		};
		parentId = entry.id;
		return entry;
	});
}

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

	test("a compaction folds the running turn's first part; the rest stays open after the run until the next message", async () => {
		const mode = createMode({ isStreaming: true });
		renderBranch(mode, [
			user("long task", 0),
			assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 0, 1_000),
			toolResult("t1", "ok", false),
			{ role: "compactionSummary", summary: "summary", tokensBefore: 10, timestamp: START + 2_000 },
			assistant([fauxToolCall("bash", { command: "pwd" }, { id: "t2" })], 3_000, 1_000),
			toolResult("t2", "ok", false),
			assistant("Done.", 5_000, 1_000, "stop"),
		]);

		const live = visibleLines(mode);
		expect(live[1]).toBe("▸ 1 tool · 0:01");
		expect(live).toContain("✓ bash pwd");

		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		expect(visibleLines(mode)).toEqual(live);

		await emit(mode, { type: "message_start", message: user("next", 10_000) });
		const folded = visibleLines(mode);
		expect(folded).not.toContain("✓ bash pwd");
		expect(folded.slice(-3)).toEqual(["▸ 1 tool · 0:04", "Done.", "next"]);
	});

	test("a finished run keeps its turn open; the next user message folds it; a turn without tools or thinking gets no row", async () => {
		const mode = createMode();
		const prompt = user("check", 0);
		const call = assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 1_000, 1_000);
		const reply = assistant("All good.", 3_000, 2_000, "stop");

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: prompt });
		await emit(mode, { type: "message_end", message: prompt });
		await emit(mode, { type: "message_start", message: call });
		await emit(mode, { type: "message_end", message: call });
		await emit(mode, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
		await emit(mode, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "a.ts" }], details: undefined },
			isError: false,
		});
		await emit(mode, { type: "message_start", message: reply });
		await emit(mode, { type: "message_end", message: reply });
		expect(visibleLines(mode)).toEqual(["check", "✓ bash ls", "All good."]);

		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		expect(visibleLines(mode)).toEqual(["check", "✓ bash ls", "All good."]);

		const plain = user("hi", 10_000);
		const answer = assistant("Hello.", 11_000, 1_000, "stop");
		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: plain });
		expect(visibleLines(mode)).toEqual(["check", "▸ 1 tool · 0:05", "All good.", "hi"]);
		await emit(mode, { type: "message_start", message: answer });
		await emit(mode, { type: "message_end", message: answer });
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		await emit(mode, { type: "message_start", message: user("bye", 20_000) });
		expect(visibleLines(mode).slice(-3)).toEqual(["hi", "Hello.", "bye"]);
	});

	test("a run that ends for an automatic retry and its retry form one turn", async () => {
		const mode = createMode();
		const prompt = user("check", 0);
		const call = assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 1_000, 1_000);
		const failed = assistant("", 2_000, 1_000, "error", "overloaded");
		const reply = assistant("All good.", 4_000, 1_000, "stop");

		await emit(mode, { type: "message_start", message: prompt });
		await emit(mode, { type: "message_start", message: call });
		await emit(mode, { type: "message_end", message: call });
		await emit(mode, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
		await emit(mode, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "a.ts" }], details: undefined },
			isError: true,
		});
		await emit(mode, { type: "message_start", message: failed });
		await emit(mode, { type: "message_end", message: failed });
		await emit(mode, { type: "agent_end", messages: [], willRetry: true });
		expect(visibleLines(mode)).toEqual(["check", "✗ bash ls", "Error: overloaded"]);

		await emit(mode, { type: "message_start", message: reply });
		await emit(mode, { type: "message_end", message: reply });
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		await emit(mode, { type: "message_start", message: user("next", 10_000) });
		expect(visibleLines(mode)).toEqual(["check", "▸ 1 tool · 0:05 · 1 error", "All good.", "next"]);
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

	test("an extension message after the reply leaves the turn open; its run is a turn of its own", async () => {
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
		expect(visibleLines(mode)).toEqual(["check", "✓ bash ls", "Checked.", "[web]", "Content fetched"]);

		// The extension message starts a run; both turns stay in full until the owner's next message.
		await emit(mode, { type: "agent_start" });
		await respond(mode, assistant([fauxThinking("read it"), fauxText("It says hi.")], 6_000, 1_000, "stop"));
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		expect(visibleLines(mode)).toEqual([
			"check",
			"✓ bash ls",
			"Checked.",
			"[web]",
			"Content fetched",
			"read it",
			"It says hi.",
		]);

		await emit(mode, { type: "message_start", message: user("next", 10_000) });
		expect(visibleLines(mode)).toEqual([
			"check",
			"▸ 1 tool · 0:03",
			"Checked.",
			"[web]",
			"Content fetched",
			"▸ 1 thinking · 0:02",
			"It says hi.",
			"next",
		]);
	});

	test("a ! command folds the turn before it", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const mode = createMode();

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("check", 0) });
		await respond(mode, assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 0, 1_000));
		await runTool(mode, "t1", "ls", 2_000);
		await respond(mode, assistant("Checked.", 2_000, 1_000, "stop"));
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		expect(visibleLines(mode)).toContain("✓ bash ls");

		await (mode.handleBashCommand as (this: ModeThis, command: string) => Promise<void>).call(mode, "git status");
		const lines = visibleLines(mode);
		expect(lines.slice(0, 3)).toEqual(["check", "▸ 1 tool · 0:03", "Checked."]);
		expect(lines.join("\n")).toContain("$ git status");
	});

	test("a restored session folds every turn but the last, which a restored ! command folds", () => {
		const mode = createMode();
		const lastTurn: AgentMessage[] = [
			user("run it", 300_000),
			assistant([fauxToolCall("bash", { command: "npm run build" }, { id: "t3" })], 301_000, 1_000),
			toolResult("t3", "built", false),
			assistant("Built.", 303_000, 1_000, "stop"),
		];
		renderBranch(mode, [...RECORDED_BRANCH, ...lastTurn]);

		expect(visibleLines(mode)).toEqual([
			"fix the bug",
			"▸ 2 tools · 2 thinking · 1:40 · 1 error",
			"Fixed it.",
			"thanks",
			"You are welcome.",
			"run it",
			"✓ bash npm run build",
			"Built.",
		]);

		const withCommand = createMode();
		renderBranch(withCommand, [
			...RECORDED_BRANCH,
			...lastTurn,
			{
				role: "bashExecution",
				command: "git status",
				output: "clean",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: START + 400_000,
			},
		]);
		expect(visibleLines(withCommand).slice(5, 8)).toEqual(["run it", "▸ 1 tool · 0:04", "Built."]);
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

	test("a cancelled automatic retry leaves its turn open", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const mode = createMode();

		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: user("check", 0) });
		await respond(mode, assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 0, 1_000));
		await runTool(mode, "t1", "ls", 2_000);
		await respond(mode, assistant("", 2_000, 1_000, "error", "overloaded"));
		await emit(mode, { type: "agent_end", messages: [], willRetry: true });
		expect(visibleLines(mode)).toContain("✓ bash ls");

		await emit(mode, { type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
		expect(visibleLines(mode)).toEqual([
			"check",
			"✓ bash ls",
			"Error: overloaded",
			"Error: Retry failed after 1 attempts: Retry cancelled",
		]);
	});
});

describe("TurnFolds in a read-only view", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	/** A finished worker session: one task, its activity and the final reply. */
	const WORKER_SESSION = RECORDED_BRANCH.slice(0, 6);

	test("a finished one-turn worker session reads as task, one row and reply; a normal session keeps it open", () => {
		const view = createMode({ view: true });
		renderBranch(view, WORKER_SESSION);
		expect(visibleLines(view)).toEqual(["fix the bug", "▸ 2 tools · 2 thinking · 1:40 · 1 error", "Fixed it."]);

		expect(view.turnFolds.toggleLast()).toBe(true);
		expect(visibleLines(view)).toContain("✗ bash npm test");

		const normal = createMode();
		renderBranch(normal, WORKER_SESSION);
		expect(visibleLines(normal)).toEqual([
			"fix the bug",
			"look at the file",
			"✓ read src/a.ts",
			"running the tests",
			"✗ bash npm test",
			"the test needs a fix",
			"Fixed it.",
		]);
	});

	test("a retry the writer appends after a failed reply folds into a row of its own", () => {
		const mode = createMode({ view: true });
		const failedRun: AgentMessage[] = [
			user("check", 0),
			assistant([fauxToolCall("bash", { command: "ls" }, { id: "t1" })], 0, 1_000),
			toolResult("t1", "ok", false),
			assistant("", 2_000, 1_000, "error", "overloaded"),
		];
		renderBranch(mode, failedRun);
		expect(visibleLines(mode)).toEqual(["check", "▸ 1 tool · 0:03", "Error: overloaded"]);

		appendBranch(mode, [assistant([fauxToolCall("bash", { command: "pwd" }, { id: "t2" })], 10_000, 1_000)], 4);
		expect(visibleLines(mode).slice(-1)).toEqual(["○ bash pwd"]);
		appendBranch(mode, [toolResult("t2", "ok", false), assistant("Checked.", 12_000, 1_000, "stop")], 5);

		expect(visibleLines(mode)).toEqual([
			"check",
			"▸ 1 tool · 0:03",
			"Error: overloaded",
			"▸ 1 tool · 0:03",
			"Checked.",
		]);
	});
});
