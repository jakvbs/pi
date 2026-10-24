import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readOptional } from "./history.ts";

/** One message sent from the editor. Counts only: the log never holds what was typed. */
export interface Usage {
	readonly at: number;
	readonly threshold: number;
	readonly chars: number;
	readonly words: number;
	/** Distinct ghosts painted since the previous message, a draft cleared without sending included. */
	readonly offered: number;
	/** Ghosts taken with Tab or Right, one key each. */
	readonly accepted: number;
	readonly insertedChars: number;
}

const FIELDS = ["at", "threshold", "chars", "words", "offered", "accepted", "insertedChars"] as const;

function isUsage(value: unknown): value is Usage {
	return (
		typeof value === "object" && value !== null && FIELDS.every((field) => Number.isFinite(Reflect.get(value, field)))
	);
}

/** A line of the log, or nothing for a line cut short by a crash or written in another shape. */
export function usageOf(line: string): Usage | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isUsage(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export async function appendUsage(file: string, usage: Usage): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${JSON.stringify(usage)}\n`);
}

export async function readUsage(file: string): Promise<Usage[]> {
	const text = (await readOptional(file)) ?? "";
	return text.split("\n").flatMap((line) => usageOf(line) ?? []);
}

function percent(part: number, whole: number): string {
	return `${whole ? ((100 * part) / whole).toFixed(1) : "0.0"}%`;
}

/** Per threshold, keystrokes saved as the replay counts them: inserted characters less one key per taken ghost. */
export function describeUsage(usages: readonly Usage[]): string {
	if (!usages.length) return "No messages logged yet.";
	const byThreshold = new Map<number, Usage[]>();
	for (const usage of usages) {
		const group = byThreshold.get(usage.threshold);
		if (group) group.push(usage);
		else byThreshold.set(usage.threshold, [usage]);
	}
	const first = usages.reduce((earliest, usage) => Math.min(earliest, usage.at), Number.POSITIVE_INFINITY);
	const since = new Date(first).toISOString().slice(0, 10);
	const lines = [...byThreshold]
		.sort(([a], [b]) => a - b)
		.map(([threshold, group]) => {
			const sum = (field: (typeof FIELDS)[number]) => group.reduce((total, usage) => total + usage[field], 0);
			const [chars, words, offered, accepted] = [sum("chars"), sum("words"), sum("offered"), sum("accepted")];
			const saved = sum("insertedChars") - accepted;
			const notTaken = words ? ((100 * (offered - accepted)) / words).toFixed(0) : "0";
			const messages = `${group.length} message${group.length === 1 ? "" : "s"}`;
			return `threshold ${threshold}: ${messages}, ${percent(saved, chars)} of keystrokes saved, ${accepted} of ${offered} ghosts taken, ${notTaken} not taken per 100 words`;
		});
	return `Since ${since}: ${lines.join("; ")}.`;
}
