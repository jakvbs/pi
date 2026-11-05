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
import { beforeAll, describe, expect, test, vi } from "vitest";
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
function createMode(options: { folding?: boolean; isStreaming?: boolean } = {}): ModeThis {
	const chatContainer = new TranscriptContainer();
	const prototype = InteractiveMode.prototype as unknown as Record<string, unknown>;
	const mode: ModeThis = {
		chatContainer,
		turnFolds: new TurnFolds(chatContainer, options.folding ?? true, 1),
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
			getShowCacheMissNotices: () => false,
			getShowTerminalProgress: () => false,
		},
		sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
		session: { retryAttempt: 0, isStreaming: options.isStreaming ?? false },
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
		"addMessageToChat",
		"renderMessage",
		"getUserMessageText",
		"handleEvent",
	]) {
		mode[name] = prototype[name];
	}
	return mode;
}

function renderBranch(mode: ModeThis, messages: AgentMessage[]): void {
	let parentId: string | null = null;
	const entries = messages.map((message, index): SessionEntry => {
		const entry: SessionEntry = {
			type: "message",
			id: `entry-${index}`,
			parentId,
			timestamp: new Date(START).toISOString(),
			message,
		};
		parentId = entry.id;
		return entry;
	});
	(mode.renderSessionEntries as (this: ModeThis, entries: SessionEntry[]) => void).call(mode, entries);
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
		]);

		expect(visibleLines(mode)).toEqual(["refactor", "▸ 1 tool · 1 thinking · 0:03 · 1 error", "Operation aborted"]);
	});

	test("a compaction ends the running turn's first part; the rest folds when the run ends", async () => {
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
		const folded = visibleLines(mode);
		expect(folded).not.toContain("✓ bash pwd");
		expect(folded.slice(-2)).toEqual(["▸ 1 tool · 0:04", "Done."]);
	});

	test("a live turn shows its activity while it runs and folds at agent_end; a turn without tools or thinking gets no row", async () => {
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
		expect(visibleLines(mode)).toEqual(["check", "▸ 1 tool · 0:05", "All good."]);

		const plain = user("hi", 10_000);
		const answer = assistant("Hello.", 11_000, 1_000, "stop");
		await emit(mode, { type: "agent_start" });
		await emit(mode, { type: "message_start", message: plain });
		await emit(mode, { type: "message_start", message: answer });
		await emit(mode, { type: "message_end", message: answer });
		await emit(mode, { type: "agent_end", messages: [], willRetry: false });
		expect(visibleLines(mode).slice(-2)).toEqual(["hi", "Hello."]);
	});

	test("a run that ends for an automatic retry keeps its turn open until the retry ends", async () => {
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
		expect(visibleLines(mode)).toEqual(["check", "▸ 1 tool · 0:05 · 1 error", "All good."]);
	});
});
