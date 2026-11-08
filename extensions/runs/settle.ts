// Settling a run: copying the end of its pi-subagents run into the record before /tmp state can expire.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastAttempt, type Outcome, type RunRecord, runDir, writeRun } from "./record.ts";
import { commitsSince } from "./worktree.ts";

/** The fields of pi-subagents' `status.json` a run reads. */
export interface SubagentStatus {
	state: string;
	error?: string;
	endedAt?: number;
	pid?: number;
	bootId?: string;
	steps?: Array<{ sessionFile?: string }>;
}

/**
 * Settles the record's last attempt when its pi-subagents run has ended: writes the outcome, the agent's final
 * message as `report-<n>.md`, the session file and the branch's commits. Idempotent; an unsettled or already
 * settled record is returned unchanged.
 */
export function settleRun(root: string, record: RunRecord, now = new Date()): RunRecord {
	const attempt = lastAttempt(record);
	if (attempt.outcome) return record;
	const status = readStatus(attempt.asyncDir);
	const outcome = settleAttempt(status, status ? runnerAlive(status) : false, now);
	if (!outcome) return record;
	const sessionFile = status?.steps?.[0]?.sessionFile ?? record.sessionFile;
	const report = sessionFile ? lastAssistantText(sessionFile) : undefined;
	if (report) writeFileSync(join(runDir(root, record.id), `report-${record.attempts.length}.md`), `${report}\n`);
	const attempts: RunRecord["attempts"] = [...record.attempts];
	attempts[attempts.length - 1] = { ...attempt, outcome };
	const settled: RunRecord = {
		...record,
		attempts,
		commits: commitsSince(record.repo, record.base, record.branch),
		...(sessionFile ? { sessionFile } : {}),
	};
	writeRun(root, settled);
	return settled;
}

/**
 * Decides whether an unsettled attempt has ended, from its pi-subagents status and whether its runner
 * process still lives. A `running` status whose runner died never changes again, so it settles as failed.
 */
export function settleAttempt(status: SubagentStatus | undefined, runnerAlive: boolean, now: Date): Outcome | undefined {
	if (!status) return { state: "lost", finishedAt: now.toISOString(), reason: "pi-subagents run directory is gone" };
	const finishedAt = new Date(status.endedAt ?? now.getTime()).toISOString();
	switch (status.state) {
		case "complete":
			return { state: "done", finishedAt };
		case "paused":
		case "stopped":
			return { state: "stopped", finishedAt };
		case "queued":
		case "running":
			return runnerAlive
				? undefined
				: { state: "failed", finishedAt: now.toISOString(), reason: "runner process exited without a final state" };
		default:
			return { state: "failed", finishedAt, ...(status.error ? { reason: status.error } : {}) };
	}
}

function readStatus(asyncDir: string): SubagentStatus | undefined {
	const file = join(asyncDir, "status.json");
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SubagentStatus) : undefined;
}

// pi-subagents rewrites status.json only when activity changes, so file age says nothing; the runner pid does.
function runnerAlive(status: SubagentStatus): boolean {
	if (status.pid === undefined) return true;
	const bootId = existsSync("/proc/sys/kernel/random/boot_id")
		? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
		: undefined;
	if (status.bootId && bootId && status.bootId !== bootId) return false;
	try {
		process.kill(status.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Text of the last assistant message in a pi session file. */
export function lastAssistantText(sessionFile: string): string | undefined {
	if (!existsSync(sessionFile)) return undefined;
	let text: string | undefined;
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line) as {
			type?: string;
			message?: { role?: string; content?: Array<{ type: string; text?: string }> | string };
		};
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		const joined =
			typeof content === "string"
				? content
				: (content ?? []).flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
		if (joined.trim()) text = joined;
	}
	return text;
}
