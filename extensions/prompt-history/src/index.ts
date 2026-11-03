import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	CONFIG_DIR_NAME,
	DynamicBorder,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, type KeyId, type SelectItem, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";

export interface HistoryItem {
	text: string;
	recency: number;
	frequency?: number;
}

interface StoredPrompt {
	text: string;
	lastUsedAt: number;
	useCount?: number;
}

interface GlobalHistoryFile {
	version: 1 | 2;
	prompts: StoredPrompt[];
	/** True once prompts from persisted Pi sessions have been merged into this file. */
	sessionHistoryCached?: boolean;
}

interface LoadedGlobalHistory {
	history: HistoryItem[];
	sessionHistoryCached: boolean;
}

interface PromptHistoryConfig {
	shortcut?: string;
	globalHistoryLimit?: number;
}

const DEFAULT_SHORTCUT = Key.ctrl("r");
const DEFAULT_GLOBAL_HISTORY_LIMIT = 1_000;
const GLOBAL_HISTORY_FILE = "pi-prompt-history-history.json";

/**
 * Resolve the picker shortcut. An environment variable takes precedence over
 * the user config so callers can change the binding for a single Pi launch.
 */
export function resolveShortcut(config: PromptHistoryConfig, environmentShortcut?: string): KeyId {
	const shortcut = environmentShortcut ?? config.shortcut ?? DEFAULT_SHORTCUT;
	return typeof shortcut === "string" && shortcut.trim() ? shortcut.trim() as KeyId : DEFAULT_SHORTCUT;
}

function agentConfigDir(): string {
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

function loadConfig(): PromptHistoryConfig {
	const path = join(agentConfigDir(), "pi-prompt-history.json");
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" ? parsed as PromptHistoryConfig : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`pi-prompt-history: unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return {};
	}
}

/**
 * Scores a subsequence match. Earlier, consecutive, and word-boundary matches rank higher.
 * Returning undefined means every query character did not occur in order.
 */
export function fuzzyScore(candidate: string, query: string): number | undefined {
	const haystack = candidate.toLocaleLowerCase();
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return 0;

	let score = 0;
	let cursor = 0;
	let previous = -2;
	for (const character of needle) {
		const found = haystack.indexOf(character, cursor);
		if (found === -1) return undefined;

		score += 1;
		if (found === previous + 1) score += 6;
		if (found === 0 || /[\s_./:-]/.test(haystack[found - 1] ?? "")) score += 3;
		score -= found - cursor;
		previous = found;
		cursor = found + 1;
	}
	return score;
}

export function mergeHistory(...histories: HistoryItem[][]): HistoryItem[] {
	const byText = new Map<string, HistoryItem>();
	for (const history of histories) {
		for (const item of history) {
			const existing = byText.get(item.text);
			if (!existing || item.recency > existing.recency) byText.set(item.text, item);
		}
	}
	return [...byText.values()];
}

/** Combine duplicate prompts, accumulating use frequency while retaining the newest timestamp. */
export function aggregateHistory(...histories: HistoryItem[][]): HistoryItem[] {
	const byText = new Map<string, HistoryItem>();
	for (const history of histories) {
		for (const item of history) {
			const existing = byText.get(item.text);
			if (!existing) {
				byText.set(item.text, { ...item, frequency: item.frequency ?? 1 });
				continue;
			}
			existing.frequency = (existing.frequency ?? 1) + (item.frequency ?? 1);
			if (item.recency > existing.recency) existing.recency = item.recency;
		}
	}
	return [...byText.values()];
}

export function rankHistory(history: HistoryItem[], query: string): HistoryItem[] {
	const terms = query.trim().split(/\s+/).filter(Boolean);
	return history
		.map((item) => {
			const score = terms.reduce<number | undefined>((total, term) => {
				if (total === undefined) return undefined;
				const termScore = fuzzyScore(item.text, term);
				return termScore === undefined ? undefined : total + termScore;
			}, 0);
			return { item, score };
		})
		.filter((match): match is { item: HistoryItem; score: number } => match.score !== undefined)
		.sort((left, right) =>
			right.score - left.score ||
			(right.item.frequency ?? 0) - (left.item.frequency ?? 0) ||
			right.item.recency - left.item.recency,
		)
		.map((match) => match.item);
}

function promptText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			block !== null && typeof block === "object" &&
			(block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/** Format a user bash command the way it was typed, so restoring it re-runs it. */
export function bashHistoryText(command: string, excludeFromContext = false): string {
	const trimmed = command.trim();
	return trimmed ? `${excludeFromContext ? "!!" : "!"}${trimmed}` : "";
}

/** Extract history text from a user prompt or a `!`/`!!` bash execution message. */
function messageHistoryText(message: { role: string }): string | undefined {
	if (message.role === "user") return promptText((message as { content?: unknown }).content);
	if (message.role === "bashExecution") {
		const { command, excludeFromContext } = message as { command?: unknown; excludeFromContext?: unknown };
		return typeof command === "string" ? bashHistoryText(command, excludeFromContext === true) : undefined;
	}
	return undefined;
}

/** Ignore accidental numeric-only submissions such as "1", "2", and "3". */
export function isMeaningfulPrompt(text: string): boolean {
	const prompt = text.trim();
	return prompt.length > 0 && !/^\d+$/.test(prompt);
}

function getPromptHistory(ctx: ExtensionContext): HistoryItem[] {
	const seen = new Set<string>();
	const result: HistoryItem[] = [];
	const branch = ctx.sessionManager.getBranch();

	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const text = messageHistoryText(entry.message);
		if (text === undefined || !isMeaningfulPrompt(text) || seen.has(text)) continue;
		seen.add(text);
		// Timestamps make current-session and global prompt recency directly comparable.
		const timestamp = entry.message.timestamp ?? Date.parse(entry.timestamp);
		result.push({ text, recency: Number.isFinite(timestamp) ? timestamp : index });
	}
	return result;
}

let sessionHistoryPromise: Promise<HistoryItem[]> | undefined;

/** Read saved prompts for one workspace, or all workspaces when cwd is omitted. */
export async function readSessionHistory(cwd?: string, sessionDir?: string): Promise<HistoryItem[]> {
	try {
		const sessions = cwd === undefined ? await SessionManager.listAll() : await SessionManager.list(cwd, sessionDir);
		const history: HistoryItem[] = [];
		for (const session of sessions) {
			try {
				for (const entry of SessionManager.open(session.path).getEntries()) {
					if (entry.type !== "message") continue;
					const text = messageHistoryText(entry.message);
					if (text === undefined || !isMeaningfulPrompt(text)) continue;
					const timestamp = entry.message.timestamp ?? Date.parse(entry.timestamp);
					history.push({ text, recency: Number.isFinite(timestamp) ? timestamp : 0 });
				}
			} catch (error) {
				console.warn(`pi-prompt-history: unable to read session ${session.path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return history;
	} catch (error) {
		console.warn(`pi-prompt-history: unable to list saved sessions: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

/** Load prompts from every persisted Pi session once per Pi process. */
function loadSessionHistory(force = false): Promise<HistoryItem[]> {
	if (force) sessionHistoryPromise = undefined;
	return sessionHistoryPromise ??= readSessionHistory();
}

function globalHistoryPath(): string {
	return join(agentConfigDir(), GLOBAL_HISTORY_FILE);
}

function loadGlobalHistory(): LoadedGlobalHistory {
	try {
		const parsed: unknown = JSON.parse(readFileSync(globalHistoryPath(), "utf8"));
		if (!parsed || typeof parsed !== "object" || !("prompts" in parsed) || !Array.isArray(parsed.prompts)) {
			return { history: [], sessionHistoryCached: false };
		}
		const file = parsed as { prompts: unknown[]; sessionHistoryCached?: unknown };
		return {
			history: file.prompts
				.filter((prompt): prompt is StoredPrompt =>
					prompt !== null && typeof prompt === "object" &&
					typeof (prompt as { text?: unknown }).text === "string" &&
					isMeaningfulPrompt((prompt as { text: string }).text) &&
					typeof (prompt as { lastUsedAt?: unknown }).lastUsedAt === "number",
				)
				.map(({ text, lastUsedAt, useCount }) => ({
					// Normalize legacy cache records written by older extension versions too.
					text: text.trim(),
					recency: lastUsedAt,
					frequency: typeof useCount === "number" && Number.isInteger(useCount) && useCount > 0 ? useCount : 1,
				})),
			sessionHistoryCached: file.sessionHistoryCached === true,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`pi-prompt-history: unable to read ${globalHistoryPath()}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { history: [], sessionHistoryCached: false };
	}
}

function saveGlobalHistory(history: HistoryItem[], limit: number, sessionHistoryCached: boolean): void {
	// The cache uses LRU eviction. Display ranking remains frequency-first in rankHistory().
	const mostRecent = aggregateHistory(
		history
			.map((item) => ({ ...item, text: item.text.trim() }))
			.filter((item) => isMeaningfulPrompt(item.text)),
	)
		.sort((left, right) => right.recency - left.recency)
		.slice(0, limit);
	const contents: GlobalHistoryFile = {
		version: 2,
		prompts: mostRecent
			.map(({ text, recency, frequency }) => ({ text, lastUsedAt: recency, useCount: frequency })),
		sessionHistoryCached,
	};
	const path = globalHistoryPath();
	try {
		mkdirSync(agentConfigDir(), { recursive: true });
		const temporaryPath = `${path}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(contents, null, "\t")}\n`, "utf8");
		renameSync(temporaryPath, path);
	} catch (error) {
		console.warn(`pi-prompt-history: unable to save ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function recordGlobalHistory(text: string, limit: number): void {
	const prompt = text.trim();
	if (!isMeaningfulPrompt(prompt)) return;
	const globalHistory = loadGlobalHistory();
	saveGlobalHistory(
		[...globalHistory.history, { text: prompt, recency: Date.now(), frequency: 1 }],
		limit,
		globalHistory.sessionHistoryCached,
	);
}

/** Mark a restored global prompt as recently used without changing its session frequency. */
function touchGlobalHistory(text: string, limit: number): void {
	const globalHistory = loadGlobalHistory();
	const existing = globalHistory.history.find((item) => item.text === text);
	saveGlobalHistory(
		[
			...globalHistory.history.filter((item) => item.text !== text),
			{ text, recency: Date.now(), frequency: existing?.frequency ?? 1 },
		],
		limit,
		globalHistory.sessionHistoryCached,
	);
}

function displayLabel(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function displayDescription(item: HistoryItem, includeFrequency: boolean): string | undefined {
	const details: string[] = [];
	if (includeFrequency) {
		const frequency = item.frequency ?? 1;
		details.push(`used ${frequency} time${frequency === 1 ? "" : "s"}`);
	}
	if (Number.isFinite(item.recency) && item.recency > 0) {
		details.push(`last used ${new Date(item.recency).toLocaleString()}`);
	}
	if (item.text.includes("\n")) details.push("multiline prompt");
	return details.length > 0 ? details.join(" • ") : undefined;
}

async function showHistory(ctx: ExtensionContext, globalHistoryLimit: number): Promise<void> {
	const sessionHistory = getPromptHistory(ctx);
	let requestRender: (() => void) | undefined;
	let selectedFromGlobal = false;
	// Use Pi's inline editor area: terminal images can paint over text overlays.
	const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		requestRender = () => tui.requestRender();
		const container = new Container();
		const input = new Input();
		let selectList: SelectList;
		let scope: "session" | "workspace" | "global" = "session";
		let loadingWorkspace = false;
		let loadingGlobal = false;
		let workspaceHistory: HistoryItem[] | undefined;
		let globalHistory: HistoryItem[] | undefined;
		let history = sessionHistory;
		let matches = history;
		let selectedIndex = 0;

		const createList = () => {
			const items: SelectItem[] = matches.slice(0, 200).map((item) => ({
				value: item.text,
				label: displayLabel(item.text),
				description: displayDescription(item, scope !== "session"),
			}));
			selectList = new SelectList(items, 10, {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			selectList.setSelectedIndex(selectedIndex);
		};

		const refresh = () => {
			matches = rankHistory(history, input.getValue());
			selectedIndex = 0;
			createList();
		};

		const moveSelection = (delta: number) => {
			if (matches.length === 0) return;
			selectedIndex = (selectedIndex + delta + matches.length) % matches.length;
			selectList.setSelectedIndex(selectedIndex);
		};

		const rebuildGlobalHistory = () => {
			if (loadingGlobal) return;
			const cachedGlobalHistory = loadGlobalHistory();
			loadingGlobal = true;
			scope = "global";
			history = [];
			refresh();
			void loadSessionHistory(true).then((savedSessionHistory) => {
				const savedHistory = aggregateHistory(savedSessionHistory);
				const savedTexts = new Set(savedHistory.map((item) => item.text));
				const ephemeralHistory = cachedGlobalHistory.history.filter((item) => !savedTexts.has(item.text));
				globalHistory = aggregateHistory(savedHistory, ephemeralHistory);
				saveGlobalHistory(globalHistory, globalHistoryLimit, true);
				loadingGlobal = false;
				if (scope === "global") {
					history = globalHistory;
					refresh();
					tui.requestRender();
				}
			});
		};

		const switchScope = () => {
			scope = scope === "session" ? "workspace" : scope === "workspace" ? "global" : "session";
			if (scope === "session") {
				history = sessionHistory;
			} else if (scope === "workspace") {
				history = workspaceHistory ?? [];
				if (!workspaceHistory && !loadingWorkspace) {
					loadingWorkspace = true;
					void readSessionHistory(ctx.cwd, ctx.sessionManager.getSessionDir()).then((savedHistory) => {
						const saved = aggregateHistory(savedHistory);
						const savedTexts = new Set(saved.map((item) => item.text));
						workspaceHistory = mergeHistory(saved, sessionHistory.filter((item) => !savedTexts.has(item.text)));
						loadingWorkspace = false;
						if (scope === "workspace") {
							history = workspaceHistory;
							refresh();
							tui.requestRender();
						}
					});
				}
			} else {
				if (!globalHistory && !loadingGlobal) {
					const cachedGlobalHistory = loadGlobalHistory();
					if (cachedGlobalHistory.sessionHistoryCached) globalHistory = cachedGlobalHistory.history;
					else rebuildGlobalHistory();
				}
				history = globalHistory ?? [];
			}
			refresh();
		};
		createList();

		return {
			get focused() {
				return input.focused;
			},
			set focused(value: boolean) {
				input.focused = value;
			},
			render(width: number) {
				container.clear();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				const scopeLabel = scope === "session" ? "This session" : scope === "workspace" ? "This workspace" : "Global";
				const loadingLabel = (scope === "workspace" && loadingWorkspace) || (scope === "global" && loadingGlobal) ? " (loading…)" : "";
				container.addChild(new Text(theme.fg("accent", theme.bold(`Prompt history — ${scopeLabel}${loadingLabel}`)), 1, 0));
				container.addChild(new Text(theme.fg("dim", "fuzzy filter: "), 1, 0));
				container.addChild(input);
				container.addChild(selectList);
				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • tab scope (session → workspace → global) • ctrl+g rebuild global • enter restore • esc cancel"), 1, 0));
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
				input.invalidate();
				selectList.invalidate();
			},
			handleInput(data: string) {
				// Handle picker controls here instead of delegating to SelectList. Its
				// handler reads the application's keybinding manager, which may not
				// match the raw key events delivered to a custom component.
				if (matchesKey(data, Key.ctrl("g"))) {
					rebuildGlobalHistory();
				} else if (matchesKey(data, Key.tab)) {
					switchScope();
				} else if (matchesKey(data, Key.up)) {
					moveSelection(-1);
				} else if (matchesKey(data, Key.down)) {
					moveSelection(1);
				} else if (matchesKey(data, Key.pageUp)) {
					moveSelection(-10);
				} else if (matchesKey(data, Key.pageDown)) {
					moveSelection(10);
				} else if (matchesKey(data, Key.enter)) {
					const item = selectList.getSelectedItem();
					if (item) {
						selectedFromGlobal = scope === "global";
						done(item.value);
					}
				} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					done(null);
				} else {
					input.handleInput(data);
					refresh();
				}
				tui.requestRender();
			},
		};
	});

	if (selected !== null) {
		if (selectedFromGlobal) touchGlobalHistory(selected, globalHistoryLimit);
		ctx.ui.setEditorText(selected);
		// setEditorText updates the editor state but does not schedule a repaint.
		// The picker close already rendered, so explicitly repaint the restored text.
		requestRender?.();
	}
}

export default function promptHistoryExtension(pi: ExtensionAPI) {
	const config = loadConfig();
	const configuredLimit = config.globalHistoryLimit ?? DEFAULT_GLOBAL_HISTORY_LIMIT;
	const globalHistoryLimit = Number.isInteger(configuredLimit) && configuredLimit > 0
		? configuredLimit
		: DEFAULT_GLOBAL_HISTORY_LIMIT;

	pi.on("input", (event) => {
		recordGlobalHistory(event.text, globalHistoryLimit);
	});
	// `!`/`!!` commands bypass the input event, so record them here. Returning
	// undefined lets Pi (or other handlers) execute the command normally.
	pi.on("user_bash", (event) => {
		recordGlobalHistory(bashHistoryText(event.command, event.excludeFromContext), globalHistoryLimit);
		return undefined;
	});

	pi.registerShortcut(resolveShortcut(config, process.env.PI_PROMPT_HISTORY_SHORTCUT), {
		description: "Fuzzy-search prompt history",
		handler: (ctx) => showHistory(ctx, globalHistoryLimit),
	});
	pi.registerCommand("history", {
		description: "Fuzzy-search prompts in the current session",
		handler: async (_args, ctx) => showHistory(ctx, globalHistoryLimit),
	});
}
