import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { WordEditor } from "./editor.ts";
import { type History, loadPrompts, type Pause, type Prompt, promptOf } from "./history.ts";
import { describeReplay, replay, THRESHOLDS } from "./replay.ts";
import { appendUsage, describeUsage, readUsage } from "./usage.ts";
import { suggest, WordModel, wordsOf } from "./words.ts";

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

export default function composerPredictions(pi: ExtensionAPI): void {
	let enabled = true;
	let threshold: number = DEFAULT_THRESHOLD;
	let editor: WordEditor | undefined;
	let active = true;
	const usageFile = join(getAgentDir(), "composer-predictions", "usage.jsonl");
	/** What the ghosts did since the previous message was sent. */
	let tally = { offered: new Set<string>(), accepted: 0, insertedChars: 0 };

	const ghostFor = (draft: string) => {
		if (!enabled || !loaded) return undefined;
		const ghost = suggest(model, draft);
		return ghost && ghost.confidence >= threshold ? ghost : undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new WordEditor(tui, theme, keybindings, ghostFor, (text) => ctx.ui.theme.fg("dim", text));
			editor.onShow = (key) => tally.offered.add(key);
			editor.onAccept = (inserted) => {
				tally.accepted++;
				tally.insertedChars += inserted.length;
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

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return undefined;
		const sent = tally;
		tally = { offered: new Set(), accepted: 0, insertedChars: 0 };
		if (enabled && loaded) {
			const usage = {
				at: Date.now(),
				threshold,
				chars: event.text.length,
				words: wordsOf(event.text).length,
				offered: sent.offered.size,
				accepted: sent.accepted,
				insertedChars: sent.insertedChars,
			};
			appendUsage(usageFile, usage).catch((error: unknown) => {
				if (active) ctx.ui.notify(`composer-predictions: usage not logged: ${String(error)}`, "warning");
			});
		}
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
			const usage = describeUsage(await readUsage(usageFile));
			ctx.ui.notify(
				`composer-predictions: ${enabled ? "on" : "off"}, threshold ${threshold}. ${describeHistory()} ${usage}`,
				"info",
			);
		},
	});
}
