import { monitorEventLoopDelay } from "node:perf_hooks";
import { CustomEditor, type ExtensionAPI, getAgentDir, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { paintGhost } from "./ghost.ts";
import { type History, loadPrompts, type Pause, type Prompt, promptOf } from "./history.ts";
import { describeReplay, replay, THRESHOLDS } from "./replay.ts";
import { suggest, WordModel } from "./words.ts";

/** On the replay of 369 of the author's prompts it saved 29.1% of keystrokes at 47 wrong ghosts per 100 words; 0.15 saved 31.0% at 62. */
const DEFAULT_THRESHOLD = 0.3;
/** Synchronous loading work between two turns of the event loop. A keystroke waits for one slice and any GC pause in it. */
const SLICE_MS = 8;
/** Each sort passes over every word, so the load sorts the new words in about this often instead of after each slice. */
const INDEX_MS = 100;
/** The sampled event-loop delay includes the sampling interval itself. */
const DELAY_RESOLUTION_MS = 1;

interface Loaded {
	readonly ms: number;
	/** Longest event-loop delay, from any work, while the history loaded. */
	readonly stallMs: number;
	readonly failures: History["failures"];
}

/**
 * One model per process. Session replacement runs the extension factory again with the module still loaded, so a
 * new session reuses the model. Prompts sent while the history loads are learned at once and kept after it.
 */
const model = new WordModel();
let prompts: Prompt[] = [];
let loading: Promise<Loaded> | undefined;
let loaded: Loaded | undefined;

function slicer(): Pause {
	let since = performance.now();
	return () => {
		if (performance.now() - since < SLICE_MS) return undefined;
		return new Promise((resolve) =>
			setImmediate(() => {
				since = performance.now();
				resolve();
			}),
		);
	};
}

async function load(): Promise<Loaded> {
	const started = performance.now();
	const delay = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
	delay.enable();
	try {
		const pause = slicer();
		const history = await loadPrompts(getAgentDir(), { pause });
		let indexed = performance.now();
		for (const prompt of history.prompts) {
			model.learn(prompt.text);
			const turn = pause();
			if (!turn) continue;
			await turn;
			if (performance.now() - indexed < INDEX_MS) continue;
			model.index();
			indexed = performance.now();
		}
		model.index();
		prompts = history.prompts.concat(prompts);
		// The delay of the last slice is sampled by the monitor's next timer.
		await new Promise((resolve) => setTimeout(resolve, 2 * DELAY_RESOLUTION_MS));
		loaded = {
			ms: Math.round(performance.now() - started),
			stallMs: Math.max(0, Math.round(delay.max / 1e6 - DELAY_RESOLUTION_MS)),
			failures: history.failures,
		};
		return loaded;
	} finally {
		delay.disable();
	}
}

function describeFailures(failures: Loaded["failures"]): string {
	return failures.map(({ source, reason }) => `${source} (${reason})`).join(", ");
}

function describeHistory(): string {
	if (!loaded) return `Loading history. Sent while loading: ${prompts.length}.`;
	const bySource = new Map<string, number>();
	for (const prompt of prompts) bySource.set(prompt.source, (bySource.get(prompt.source) ?? 0) + 1);
	const sources = Array.from(bySource, ([source, count]) => `${source} ${count}`).join(", ");
	const failed = loaded.failures.length ? ` Not read: ${describeFailures(loaded.failures)}.` : "";
	return `${prompts.length} prompts (${sources}), ${model.size} words, loaded in ${loaded.ms} ms with the event loop held at most ${loaded.stallMs} ms.${failed}`;
}

class WordEditor extends CustomEditor {
	private readonly keys: KeybindingsManager;
	private readonly ghostFor: (draft: string) => string | undefined;
	private readonly dim: (text: string) => string;
	/** Render runs on every frame, the model only when the draft changes. */
	private cached: { draft: string; ghost: string | undefined } | undefined;
	onAccept: ((ghost: string) => void) | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		ghostFor: (draft: string) => string | undefined,
		dim: (text: string) => string,
	) {
		super(tui, theme, keybindings);
		this.keys = keybindings;
		this.ghostFor = ghostFor;
		this.dim = dim;
	}

	refresh(): void {
		this.cached = undefined;
		this.tui.requestRender();
	}

	private ghost(): string | undefined {
		if (this.isShowingAutocomplete()) return undefined;
		const draft = this.getText();
		if (draft.includes("\n") || this.getCursor().col !== draft.length) return undefined;
		if (this.cached?.draft !== draft) this.cached = { draft, ghost: this.ghostFor(draft) };
		return this.cached.ghost;
	}

	override handleInput(data: string): void {
		const ghost = this.ghost();
		const tab = this.keys.matches(data, "tui.input.tab");
		if (ghost && (tab || this.keys.matches(data, "tui.editor.cursorRight"))) {
			this.insertTextAtCursor(tab ? `${ghost} ` : ghost);
			this.onAccept?.(ghost);
			return;
		}
		super.handleInput(data);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const ghost = this.ghost();
		return ghost ? paintGhost(lines, ghost, this.dim) : lines;
	}
}

export default function composerPredictions(pi: ExtensionAPI): void {
	let enabled = true;
	let threshold: number = DEFAULT_THRESHOLD;
	let editor: WordEditor | undefined;
	let active = true;
	const stats = { accepted: 0, insertedChars: 0, sentChars: 0 };

	const ghostFor = (draft: string) => {
		if (!enabled || !loaded) return undefined;
		const ghost = suggest(model, draft);
		return ghost && ghost.confidence >= threshold ? ghost.rest : undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new WordEditor(tui, theme, keybindings, ghostFor, (text) => ctx.ui.theme.fg("dim", text));
			editor.onAccept = (ghost) => {
				stats.accepted++;
				stats.insertedChars += ghost.length;
			};
			return editor;
		});
		if (loaded) return;
		const starts = !loading;
		loading ??= load();
		loading
			.then(({ failures }) => {
				if (!active) return;
				editor?.refresh();
				if (starts && failures.length) {
					ctx.ui.notify(`composer-predictions: history not read from ${describeFailures(failures)}`, "warning");
				}
			})
			.catch((error: unknown) => {
				if (active) ctx.ui.notify(`composer-predictions: history not loaded: ${String(error)}`, "warning");
			});
	});

	pi.on("session_shutdown", () => {
		active = false;
	});

	pi.on("input", (event) => {
		if (event.source !== "interactive") return undefined;
		stats.sentChars += event.text.length;
		const prompt = promptOf(event.text, Date.now(), "pi");
		if (!prompt) return undefined;
		model.learn(prompt.text);
		prompts.push(prompt);
		editor?.refresh();
		return undefined;
	});

	const choices = ["on", "off", ...THRESHOLDS.map(String), "replay"];
	pi.registerCommand("predict", {
		description: "Word completion: on, off, a confidence threshold, replay (no argument: status)",
		getArgumentCompletions: (prefix) =>
			choices.filter((name) => name.startsWith(prefix.trim())).map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "on" || command === "off") enabled = command === "on";
			else if (THRESHOLDS.map(String).includes(command)) threshold = Number(command);
			else if (command === "replay") {
				ctx.ui.notify("composer-predictions: replaying…", "info");
				await new Promise((resolve) => setTimeout(resolve, 0));
				ctx.ui.notify(describeReplay("replay", replay(prompts.map((prompt) => prompt.text))), "info");
				return;
			}
			editor?.refresh();
			const share = stats.sentChars ? ` (${((100 * stats.insertedChars) / stats.sentChars).toFixed(0)}%)` : "";
			ctx.ui.notify(
				`composer-predictions: ${enabled ? "on" : "off"}, threshold ${threshold}. ${describeHistory()} Accepted ${stats.accepted} ghosts, ${stats.insertedChars} of ${stats.sentChars} sent characters${share}.`,
				"info",
			);
		},
	});
}
