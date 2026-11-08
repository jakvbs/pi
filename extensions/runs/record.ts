// The durable run record: one folder per run, its state derived from the pi-subagents run it launched.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunRole } from "./roles.ts";

/** How an attempt ended. `lost` means the pi-subagents run directory disappeared before the run was settled. */
export type OutcomeState = "done" | "failed" | "stopped" | "lost";

export interface Outcome {
	state: OutcomeState;
	finishedAt: string;
	reason?: string;
}

/** One launch of the agent: the first start, then one per resume. */
export interface Attempt {
	subagentRunId: string;
	asyncDir: string;
	startedAt: string;
	outcome?: Outcome;
}

export interface RunRecord {
	version: 1;
	id: string;
	label: string;
	ticket?: string;
	repo: string;
	/** Commit the branch pointed at when this run started; `commits` lists what the run added on top. */
	base: string;
	branch: string;
	worktree: string;
	agent: string;
	role?: RunRole;
	model?: string;
	modelSource?: string;
	skills: string[];
	attempts: [Attempt, ...Attempt[]];
	commits: string[];
	sessionFile?: string;
}

export type RunState = OutcomeState | "running";

/** Root folder of all run records: `PI_RUNS_DIR`, else `~/.local/state/pi/runs`, outside any repository so no AGENTS.md above it loads into a worktree. */
export function runsRoot(): string {
	return process.env.PI_RUNS_DIR ?? join(homedir(), ".local", "state", "pi", "runs");
}

/** A sortable, readable id: date, label slug and a random suffix. */
export function newRunId(label: string, now: Date): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)
		.replace(/-$/, "");
	return `${now.toISOString().slice(0, 10)}-${slug || "run"}-${randomBytes(2).toString("hex")}`;
}

export function runDir(root: string, id: string): string {
	return join(root, id);
}

export function lastAttempt(record: RunRecord): Attempt {
	return record.attempts[record.attempts.length - 1];
}

export function runState(record: RunRecord): RunState {
	return lastAttempt(record).outcome?.state ?? "running";
}

export function readRun(root: string, id: string): RunRecord | undefined {
	const file = join(runDir(root, id), "run.json");
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RunRecord) : undefined;
}

/** Writes through a rename, so a concurrent reader never sees a torn file. */
export function writeRun(root: string, record: RunRecord): void {
	const dir = runDir(root, record.id);
	mkdirSync(dir, { recursive: true });
	const temp = join(dir, `.run.json.${process.pid}`);
	writeFileSync(temp, `${JSON.stringify(record, null, "\t")}\n`);
	renameSync(temp, join(dir, "run.json"));
}

/** Newest first. */
export function listRuns(root: string): RunRecord[] {
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.sort()
		.reverse()
		.flatMap((id) => readRun(root, id) ?? []);
}
