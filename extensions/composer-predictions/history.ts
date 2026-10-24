import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Source = "pi" | "claude" | "codex" | "omp";

export interface Prompt {
	readonly text: string;
	/** Epoch milliseconds. pi-prompt-history keeps only the last use of a prompt. */
	readonly at: number;
	readonly source: Source;
}

export interface History {
	/** Oldest first. */
	readonly prompts: Prompt[];
	/** Sources whose history exists but could not be read. Each fails alone. */
	readonly failures: readonly { readonly source: Source; readonly reason: string }[];
}

/** Gives the event loop a turn when the work since the last turn ran long enough, and resolves nothing otherwise. */
export type Pause = () => Promise<void> | undefined;

interface Where {
	readonly agentDir: string;
	readonly home: string;
}

/** Longer prompts are pastes and logs, not the user's typing. */
const MAX_PROMPT_CHARS = 2_000;
const PLACEHOLDERS = /\[(?:Image|Pasted text)[^\]]*\]/g;

/** A prompt the user typed, or nothing for anything else a history file holds. */
export function promptOf(text: unknown, at: unknown, source: Source): Prompt | undefined {
	if (typeof text !== "string" || !text || text.length > MAX_PROMPT_CHARS) return undefined;
	if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
	return { text, at, source };
}

export async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function jsonLines(
	path: string,
	pause: Pause,
	read: (entry: Record<string, unknown>) => Prompt | undefined,
): Promise<Prompt[]> {
	const prompts: Prompt[] = [];
	for (const line of (await readOptional(path))?.split("\n") ?? []) {
		await pause();
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			// Claude Code history has lines cut mid-write.
			continue;
		}
		const prompt = typeof entry === "object" && entry ? read(entry as Record<string, unknown>) : undefined;
		if (prompt) prompts.push(prompt);
	}
	return prompts;
}

const SOURCES: Record<Source, (where: Where, pause: Pause) => Promise<Prompt[]>> = {
	/** Kept by @light4/pi-prompt-history. */
	pi: async ({ agentDir }) => {
		const text = await readOptional(join(agentDir, "pi-prompt-history-history.json"));
		if (text === undefined) return [];
		const entries = (JSON.parse(text) as { prompts?: unknown } | null)?.prompts;
		if (!Array.isArray(entries)) throw new Error("no prompts array");
		return entries.flatMap((entry: { text?: unknown; lastUsedAt?: unknown } | null) => {
			const prompt = promptOf(entry?.text, entry?.lastUsedAt, "pi");
			return prompt ? [prompt] : [];
		});
	},
	claude: ({ home }, pause) =>
		jsonLines(join(home, ".claude/history.jsonl"), pause, (entry) =>
			promptOf(
				typeof entry.display === "string" ? entry.display.replace(PLACEHOLDERS, " ") : undefined,
				entry.timestamp,
				"claude",
			),
		),
	codex: ({ home }, pause) =>
		jsonLines(join(home, ".codex/history.jsonl"), pause, (entry) =>
			promptOf(entry.text, typeof entry.ts === "number" ? entry.ts * 1000 : undefined, "codex"),
		),
	/** One synchronous query: about 10 ms for 5,000 prompts, and no read lock held across turns of the event loop. */
	omp: async ({ home }) => {
		const path = join(home, ".omp/agent/history.db");
		if (!existsSync(path)) return [];
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			const rows = db
				.prepare("select prompt, created_at from history where length(prompt) <= ?")
				.all(MAX_PROMPT_CHARS);
			return rows.flatMap((row) => {
				const prompt = promptOf(
					row.prompt,
					typeof row.created_at === "number" ? row.created_at * 1000 : undefined,
					"omp",
				);
				return prompt ? [prompt] : [];
			});
		} finally {
			db.close();
		}
	},
};

/** Prompts the user typed into pi, Claude Code, Codex and oh-my-pi. A source that cannot be read is reported and skipped. */
export async function loadPrompts(
	agentDir: string,
	{ home = homedir(), pause = () => undefined }: { home?: string; pause?: Pause } = {},
): Promise<History> {
	let prompts: Prompt[] = [];
	const failures: History["failures"][number][] = [];
	for (const [source, load] of Object.entries(SOURCES) as [Source, (typeof SOURCES)[Source]][]) {
		try {
			prompts = prompts.concat(await load({ agentDir, home }, pause));
		} catch (error) {
			failures.push({ source, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { prompts: prompts.sort((a, b) => a.at - b.at), failures };
}
