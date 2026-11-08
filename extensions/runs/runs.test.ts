import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { newRunId, type RunRecord, readRun, runDir, runState, writeRun } from "./record.ts";
import { settleAttempt, settleRun } from "./settle.ts";
import { callSubagents, launchDetails } from "./subagents-rpc.ts";
import { prepareWorktree, primaryCheckout } from "./worktree.ts";

const NOW = new Date("2026-11-08T10:00:00.000Z");

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function repoWithOneCommit(): string {
	const repo = mkdtempSync(join(tmpdir(), "runs-repo-"));
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "t");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git(repo, "add", "a.txt");
	git(repo, "commit", "-q", "-m", "init");
	return repo;
}

test("an attempt settles from the pi-subagents state and the runner's life", () => {
	assert.deepEqual(settleAttempt({ state: "complete", endedAt: NOW.getTime() }, false, NOW), {
		state: "done",
		finishedAt: NOW.toISOString(),
	});
	assert.equal(settleAttempt({ state: "paused" }, true, NOW)?.state, "stopped");
	assert.equal(settleAttempt({ state: "running" }, true, NOW), undefined);
	assert.deepEqual(settleAttempt({ state: "running" }, false, NOW), {
		state: "failed",
		finishedAt: NOW.toISOString(),
		reason: "runner process exited without a final state",
	});
	assert.deepEqual(settleAttempt({ state: "failed", error: "boom" }, false, NOW), {
		state: "failed",
		finishedAt: NOW.toISOString(),
		reason: "boom",
	});
	assert.equal(settleAttempt(undefined, false, NOW)?.state, "lost");
});

test("a run id is dated, slugged from the label and unique", () => {
	const id = newRunId("Inline model setup in chat · F422", NOW);
	assert.match(id, /^2026-11-08-inline-model-setup-in-chat-f422-[0-9a-f]{4}$/);
	assert.notEqual(id, newRunId("Inline model setup in chat · F422", NOW));
});

test("a finished run records its outcome, report, session and commits once", () => {
	const repo = repoWithOneCommit();
	const root = mkdtempSync(join(tmpdir(), "runs-root-"));
	const id = "2026-11-08-demo-0000";
	const branch = `run/${id}`;
	const { base, worktree, created } = prepareWorktree(repo, branch, join(runDir(root, id), "worktree"));
	assert.equal(created, true);
	assert.equal(base, git(repo, "rev-parse", "HEAD"));
	writeFileSync(join(worktree, "b.txt"), "b\n");
	git(worktree, "add", "b.txt");
	git(worktree, "commit", "-q", "-m", "add b");

	const asyncDir = mkdtempSync(join(tmpdir(), "runs-async-"));
	const sessionFile = join(asyncDir, "session.jsonl");
	writeFileSync(
		sessionFile,
		[
			{ type: "session", id: "s" },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "working" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Added b.txt." }] } },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n"),
	);
	writeFileSync(
		join(asyncDir, "status.json"),
		JSON.stringify({ state: "complete", endedAt: NOW.getTime(), steps: [{ sessionFile }] }),
	);
	const record: RunRecord = {
		version: 1,
		id,
		label: "demo",
		repo,
		base,
		branch,
		worktree,
		agent: "scout-agent",
		skills: [],
		attempts: [{ subagentRunId: "sub-1", asyncDir, startedAt: NOW.toISOString() }],
		commits: [],
	};
	writeRun(root, record);

	const settled = settleRun(root, record, NOW);
	assert.equal(runState(settled), "done");
	assert.deepEqual(
		settled.commits.map((commit) => commit.replace(/^\w+ /, "")),
		["add b"],
	);
	assert.equal(settled.sessionFile, sessionFile);
	assert.equal(readFileSync(join(runDir(root, id), "report-1.md"), "utf8"), "Added b.txt.\n");
	assert.deepEqual(readRun(root, id), settled);
	assert.equal(settleRun(root, settled, NOW), settled);
});

test("a run reuses its branch's worktree, and a new branch starts at the HEAD of the checkout it came from", () => {
	const repo = repoWithOneCommit();
	const root = mkdtempSync(join(tmpdir(), "runs-root-"));
	const first = prepareWorktree(repo, "run/a", join(root, "a", "worktree"));
	writeFileSync(join(first.worktree, "c.txt"), "c\n");
	git(first.worktree, "add", "c.txt");
	git(first.worktree, "commit", "-q", "-m", "add c");
	const second = prepareWorktree(repo, "run/a", join(root, "b", "worktree"));
	assert.deepEqual(second, { base: git(repo, "rev-parse", "run/a"), worktree: first.worktree, created: false });
	assert.equal(primaryCheckout(first.worktree), repo);
	const third = prepareWorktree(first.worktree, "run/b", join(root, "c", "worktree"));
	assert.equal(third.base, git(first.worktree, "rev-parse", "HEAD"));
	assert.notEqual(third.base, git(repo, "rev-parse", "HEAD"));
});

test("the pi-subagents client resolves a reply's data and rejects its error", async () => {
	const events = createEventBus();
	events.on("subagents:rpc:v1:request", (raw) => {
		const request = raw as { requestId: string; method: string };
		const reply =
			request.method === "spawn"
				? { version: 1, requestId: request.requestId, success: true, data: { text: "ok", details: { asyncId: "r1", asyncDir: "/d" } } }
				: { version: 1, requestId: request.requestId, success: false, error: { code: "not_found", message: "no run" } };
		events.emit(`subagents:rpc:v1:reply:${request.requestId}`, reply);
	});
	assert.deepEqual(launchDetails(await callSubagents(events, "spawn", {})), { asyncId: "r1", asyncDir: "/d" });
	await assert.rejects(callSubagents(events, "stop", { id: "x" }), /stop failed \(not_found\): no run/);
});
