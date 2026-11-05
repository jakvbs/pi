import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("InteractiveMode compaction events", () => {
	test("uses the cache miss notice setting for compaction and branch summary costs", () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const addCompactionCostNotice = Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice") as (
			this: { chatContainer: Container; settingsManager: { getShowCacheMissNotices(): boolean } },
			notice: {
				type: "compaction_cost";
				kind: "compaction" | "branch_summary";
				usage: Usage;
			},
		) => void;

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		addCompactionCostNotice.call(enabled, { type: "compaction_cost", kind: "compaction", usage });
		addCompactionCostNotice.call(enabled, {
			type: "compaction_cost",
			kind: "branch_summary",
			usage,
		});
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compaction: 100 tokens billed (~$0.13)");
		expect(output).toContain("Branch summary: 100 tokens billed (~$0.13)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		addCompactionCostNotice.call(disabled, { type: "compaction_cost", kind: "compaction", usage });
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("renders each compaction cost after its summary", () => {
		const currentUsage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const previousUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		};
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "current",
				parentId: "previous",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "current summary",
				firstKeptEntryId: "kept",
				tokensBefore: 200,
				usage: currentUsage,
			},
			{
				type: "compaction",
				id: "previous",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				summary: "previous summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				usage: previousUsage,
			},
		];
		const fakeThis = { renderSessionItems: vi.fn() };
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeThis,
			entries: SessionEntry[],
		) => void;

		renderSessionEntries.call(fakeThis, entries);

		expect(fakeThis.renderSessionItems).toHaveBeenCalledWith(
			[
				expect.objectContaining({ role: "compactionSummary", summary: "current summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: currentUsage },
				expect.objectContaining({ role: "compactionSummary", summary: "previous summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: previousUsage },
			],
			expect.any(Map),
			{},
		);
		const [items, messageMeta] = fakeThis.renderSessionItems.mock.calls[0] as [
			unknown[],
			Map<unknown, { id: string; timestamp: string }>,
		];
		expect(messageMeta.get(items[0])).toEqual({ id: "current", timestamp: "2025-01-02T00:00:00Z" });
		expect(messageMeta.get(items[2])).toEqual({ id: "previous", timestamp: "2025-01-01T00:00:00Z" });
	});

	test("renders the whole branch with each compaction as a marker in place", () => {
		const usage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const sessionManager = SessionManager.inMemory();
		const user = (text: string) => sessionManager.appendMessage({ role: "user", content: text, timestamp: 0 });
		const reply = (text: string) =>
			sessionManager.appendMessage({ ...fauxAssistantMessage(text), usage, timestamp: 0 });
		user("one");
		reply("reply one");
		const keptByFirst = user("two");
		reply("reply two");
		sessionManager.appendCompaction("first summary", keptByFirst, 100, undefined, undefined, usage);
		const keptBySecond = user("three");
		reply("reply three");
		sessionManager.appendCompaction("second summary", keptBySecond, 200);
		user("four");
		reply("reply four");

		const rendered: string[] = [];
		const text = (message: AgentMessage) =>
			message.role === "user" || message.role === "assistant"
				? typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
				: "";
		const fakeThis = {
			sessionManager,
			pendingTools: new Map(),
			footer: { invalidate: vi.fn() },
			settingsManager: { getShowCacheMissNotices: () => false },
			ui: { requestRender: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			renderProjectTrustWarningIfNeeded: vi.fn(),
			showStatus: vi.fn(),
			session: { isStreaming: false },
			turnFolds: { reset: vi.fn(), end: vi.fn() },
			addMessageToChat: (message: AgentMessage) =>
				rendered.push(
					message.role === "compactionSummary"
						? `marker: ${message.summary}`
						: `${message.role}: ${text(message)}`,
				),
			addCompactionCostNotice: () => rendered.push("compaction cost"),
			renderSessionEntries: Reflect.get(InteractiveMode.prototype, "renderSessionEntries"),
			renderSessionItems: Reflect.get(InteractiveMode.prototype, "renderSessionItems"),
		};
		const renderInitialMessages = Reflect.get(InteractiveMode.prototype, "renderInitialMessages") as (
			this: typeof fakeThis,
		) => void;

		renderInitialMessages.call(fakeThis);

		expect(rendered).toEqual([
			"user: one",
			"assistant: reply one",
			"user: two",
			"assistant: reply two",
			"marker: first summary",
			"compaction cost",
			"user: three",
			"assistant: reply three",
			"marker: second summary",
			"user: four",
			"assistant: reply four",
		]);
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Session compacted 2 times");
	});

	test("appends the marker below the kept transcript when a compaction ends or is appended", async () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		initTheme("dark");
		const chatContainer = new Container();
		chatContainer.addChild(new Text("earlier message", 0, 0));
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			defaultEditor: {},
			chatContainer,
			addMessageToChat: (message: AgentMessage) =>
				chatContainer.addChild(
					new Text(message.role === "compactionSummary" ? `marker: ${message.summary}` : message.role, 0, 0),
				),
			addCompactionMarker: Reflect.get(InteractiveMode.prototype, "addCompactionMarker"),
			addCompactionCostNotice: Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice"),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false, getShowCacheMissNotices: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: AgentSessionEvent,
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: { summary: "manual summary", firstKeptEntryId: "kept", tokensBefore: 123, usage },
			aborted: false,
			willRetry: false,
		});
		await handleEvent.call(fakeThis, {
			type: "entry_appended",
			entry: {
				type: "compaction",
				id: "boundary",
				parentId: "kept",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "boundary summary",
				firstKeptEntryId: "kept",
				tokensBefore: 456,
			},
		});

		expect(
			stripAnsi(chatContainer.render(120).join("\n"))
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		).toEqual([
			"earlier message",
			"marker: manual summary",
			"Compaction: 100 tokens billed (~$0.13)",
			"marker: boundary summary",
		]);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("updates the working state when the same agent run resumes after compaction", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			activeStatusIndicator: undefined,
			workingVisible: true,
			showWorkingStatusIndicator: vi.fn(),
			clearStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "turn_start" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(true);
		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		fakeThis.workingVisible = false;
		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	// Regression test for #9340.
	test("routes interactive response aborts through AgentSession", () => {
		const abort = vi.fn(async () => {});
		const ui = {
			clearAllQueues: () => ({ steering: [], followUp: [] }),
			updatePendingMessagesDisplay: vi.fn(),
			session: { abort },
		};
		const restoreQueuedMessagesToEditor = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
			this: typeof ui,
			options?: { abort?: boolean },
		) => number;

		restoreQueuedMessagesToEditor.call(ui, { abort: true });

		expect(abort).toHaveBeenCalledOnce();
	});

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
