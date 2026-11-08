import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createEventBus, ExtensionRunner, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { loadExtensions } from "../../packages/coding-agent/src/core/extensions/loader.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
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

for (const [session, behavior] of [
	["absent", "spawns when no session was recorded"],
	["missing", "spawns when the recorded session file does not exist"],
	["existing", "resumes the existing session"],
	["stale", "spawns instead of resuming an older attempt's session"],
	["running", "preserves the refusal to resume a running attempt"],
] as const) {
	test(`resume keeps the run and ${behavior}`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "runs-resume-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const id = "2026-11-08-resume-0000";
		const dir = runDir(root, id);
		const asyncDir = join(root, "async-1");
		mkdirSync(asyncDir);
		const sessionFile = join(asyncDir, "session.jsonl");
		if (session === "existing") writeFileSync(sessionFile, '{"type":"session","id":"s"}\n');
		writeFileSync(
			join(asyncDir, "status.json"),
			JSON.stringify({
				state: session === "running" ? "running" : "failed",
				steps: [session === "absent" || session === "stale" ? {} : { sessionFile }],
			}),
		);
		const record: RunRecord = {
			version: 1,
			id,
			label: "resume",
			repo: root,
			base: "base",
			branch: `run/${id}`,
			worktree: join(dir, "worktree"),
			agent: "scout-agent",
			model: "test/model:high",
			skills: ["scout-mode"],
			attempts: [
				{
					subagentRunId: "sub-1",
					asyncDir,
					startedAt: NOW.toISOString(),
					outcome: { state: "failed", finishedAt: NOW.toISOString() },
				},
			],
			commits: ["abc existing work"],
		};
		if (session === "stale") {
			record.sessionFile = join(root, "older-session.jsonl");
			writeFileSync(record.sessionFile, '{"type":"session","id":"older"}\n');
			record.attempts.unshift({
				subagentRunId: "sub-0",
				asyncDir: join(root, "async-0"),
				startedAt: NOW.toISOString(),
				outcome: { state: "done", finishedAt: NOW.toISOString() },
			});
		}
		if (session === "running") delete record.attempts[0].outcome;
		writeRun(root, record);
		writeFileSync(join(dir, "task.md"), "Original task.\n\nTicket: /ticket.md\n");
		const previousRoot = process.env.PI_RUNS_DIR;
		const previousChild = process.env.PI_SUBAGENT_CHILD;
		process.env.PI_RUNS_DIR = root;
		process.env.PI_SUBAGENT_CHILD = "0";
		t.after(() => {
			if (previousRoot === undefined) delete process.env.PI_RUNS_DIR;
			else process.env.PI_RUNS_DIR = previousRoot;
			if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = previousChild;
		});
		const events = createEventBus();
		const requests: unknown[] = [];
		events.on("subagents:rpc:v1:request", (raw) => {
			// The event bus erases the request type emitted by our client.
			const request = raw as { requestId: string; method: string; params: Record<string, unknown> };
			requests.push({ method: request.method, params: request.params });
			events.emit(
				`subagents:rpc:v1:reply:${request.requestId}`,
				session === "running"
					? { success: false, error: { code: "invalid_state", message: "Run is still running." } }
					: { success: true, data: { details: { asyncId: "sub-2", asyncDir: join(root, "async-2") } } },
			);
		});
		const { extensions, runtime, errors } = await loadExtensions(
			[fileURLToPath(new URL("./index.ts", import.meta.url))], root, events,
		);
		assert.deepEqual(errors, []);
		const models = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false });
		const runner = new ExtensionRunner(extensions, runtime, root, SessionManager.inMemory(root), new ModelRegistry(models));
		const tool = runner.getAllRegisteredTools().find((tool) => tool.definition.name === "run");
		assert.ok(tool);
		const execution = tool.definition.execute(
			"resume", { action: "resume", id, message: "Try again." },
			undefined, undefined, runner.createToolContext("resume", undefined),
		);
		if (session === "running") {
			await assert.rejects(execution, /Run is still running/);
			assert.deepEqual(requests, [{ method: "resume", params: { id: "sub-1", message: "Try again." } }]);
			assert.deepEqual(readRun(root, id), record);
			return;
		}
		const result = await execution;
		assert.deepEqual(requests, [
			session === "existing"
				? { method: "resume", params: { id: "sub-1", message: "Try again." } }
				: {
					method: "spawn",
					params: {
						agent: "scout-agent",
						task: "Original task.\n\nTicket: /ticket.md\n\nTry again.",
						cwd: record.worktree,
						sessionDir: join(dir, "sessions"),
						context: "fresh",
						async: true,
						model: record.model,
						skill: record.skills,
					},
				},
		]);
		const resumed = readRun(root, id);
		assert.ok(resumed);
		const nextAttempt = resumed.attempts[record.attempts.length];
		assert.ok(nextAttempt);
		assert.equal(new Date(nextAttempt.startedAt).toISOString(), nextAttempt.startedAt);
		assert.deepEqual(resumed, {
			...record,
			attempts: [
				...record.attempts,
				{ subagentRunId: "sub-2", asyncDir: join(root, "async-2"), startedAt: nextAttempt.startedAt },
			],
		});
		assert.deepEqual(result.content, [{ type: "text", text: `Resumed run ${id} (attempt ${record.attempts.length + 1}).` }]);
	});
}
