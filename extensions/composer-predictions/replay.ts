import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadPrompts } from "./history.ts";
import { suggest, WORD, WordModel } from "./words.ts";

export const THRESHOLDS = [0.15, 0.3, 0.45] as const;
/** Prompts typed out per replay, the newest ones. */
export const REPLAY_PROMPTS = 400;
/** A retype fixes a typo in one of the prompts just before it and would be predicted from it almost whole. */
const RETYPE_WINDOW = 5;
const RETYPE_SIMILARITY = 0.8;

export interface ReplayResult {
	readonly typedOut: number;
	readonly retypes: number;
	readonly keys: number;
	readonly words: number;
	/** Keystrokes saved when every right ghost is taken, net of the accepting key, and words that showed a wrong ghost. */
	readonly byThreshold: readonly { readonly threshold: number; saved: number; wrongWords: number }[];
	readonly msPerQuery: number;
}

/** One line of conversational length, as opposed to a paste or a pasted-in skill. */
function isTyped(text: string): boolean {
	const trimmed = text.trim();
	return !trimmed.includes("\n") && trimmed.length >= 2 && trimmed.length <= 300 && !trimmed.startsWith("<");
}

function similarity(a: string, b: string): number {
	let row = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++) {
			next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		row = next;
	}
	return 1 - row[b.length]! / Math.max(a.length, b.length, 1);
}

/**
 * Types out the newest `count` typed prompts letter by letter with a model trained on every prompt before them.
 * The model learns each later prompt after it is typed, as the editor does after each submit.
 */
export function replay(prompts: readonly string[], count = REPLAY_PROMPTS): ReplayResult {
	const typed = prompts.flatMap((prompt, index) => (isTyped(prompt) ? [index] : [])).slice(-count);
	const scored = new Set(typed);
	const first = typed[0] ?? prompts.length;
	const model = new WordModel();
	for (const prompt of prompts.slice(0, first)) model.learn(prompt);
	const result = {
		typedOut: 0,
		retypes: 0,
		keys: 0,
		words: 0,
		byThreshold: THRESHOLDS.map((threshold) => ({ threshold, saved: 0, wrongWords: 0 })),
		msPerQuery: 0,
	};
	let queries = 0;
	let spent = 0;

	const typeOut = (text: string) => {
		result.typedOut++;
		result.keys += text.length;
		for (const match of text.matchAll(WORD)) {
			const word = match[0];
			const end = match.index + word.length;
			const followedBySpace = text[end] === " ";
			const accepted = new Set<number>();
			const wrong = new Set<number>();
			result.words++;
			for (let length = 0; length < word.length && accepted.size < THRESHOLDS.length; length++) {
				const started = performance.now();
				const ghost = suggest(model, text.slice(0, match.index + length));
				spent += performance.now() - started;
				queries++;
				if (!ghost) continue;
				const right = ghost.rest === word.slice(length);
				const gain = word.length - length - 1 + (followedBySpace ? 1 : 0);
				for (const [index, { threshold }] of result.byThreshold.entries()) {
					if (accepted.has(index) || ghost.confidence < threshold) continue;
					if (!right) wrong.add(index);
					else if (gain > 0) {
						accepted.add(index);
						result.byThreshold[index]!.saved += gain;
					}
				}
			}
			for (const index of wrong) result.byThreshold[index]!.wrongWords++;
		}
	};

	for (let index = first; index < prompts.length; index++) {
		const prompt = prompts[index]!;
		if (scored.has(index)) {
			const text = prompt.trim().toLowerCase();
			const retype = prompts.slice(Math.max(0, index - RETYPE_WINDOW), index).some((earlier) => {
				const other = earlier.trim().toLowerCase();
				return other !== text && similarity(other, text) >= RETYPE_SIMILARITY;
			});
			if (retype) result.retypes++;
			else typeOut(text);
		}
		model.learn(prompt);
	}
	result.msPerQuery = queries ? spent / queries : 0;
	return result;
}

export function describeReplay(label: string, result: ReplayResult): string {
	const cells = result.byThreshold.map(
		({ threshold, saved, wrongWords }) =>
			`at ${threshold}: ${((100 * saved) / result.keys).toFixed(1)}% keys saved, ${((100 * wrongWords) / result.words).toFixed(0)} wrong per 100 words`,
	);
	return `${label}: ${result.typedOut} prompts (${result.retypes} retypes skipped), ${cells.join("; ")}; ${(1000 * result.msPerQuery).toFixed(0)} µs per ghost`;
}

if (import.meta.main) {
	const { prompts, failures } = await loadPrompts(getAgentDir());
	for (const { source, reason } of failures) console.warn(`${source} history not read: ${reason}`);
	console.log(describeReplay("all sources", replay(prompts.map((prompt) => prompt.text))));
	console.log(
		describeReplay(
			"pi only",
			replay(prompts.filter((prompt) => prompt.source === "pi").map((prompt) => prompt.text)),
		),
	);
}
