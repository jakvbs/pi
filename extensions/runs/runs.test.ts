import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createEventBus, ExtensionRunner, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { loadExtensions } from "../../packages/coding-agent/src/core/extensions/loader.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import type { Settings } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { listRuns, newRunId, type RunRecord, readRun, runDir, runState, writeRun } from "./record.ts";
import { resolveRole, withRequiredReading } from "./roles.ts";
import { runnerAlive, settleAttempt, settleRun } from "./settle.ts";
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
	["status-gone", "uses resume when the last attempt's status is gone"],
	["clean", "refuses a clean dead attempt even with an existing session"],
	["live", "allows a clean attempt with a live process"],
] as const) {
	test(`resume keeps the run and ${behavior}`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "runs-resume-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const id = "2026-11-08-resume-0000";
		const dir = runDir(root, id);
		const asyncDir = join(root, "async-1");
		mkdirSync(asyncDir);
		const sessionFile = join(asyncDir, "session.jsonl");
		if (session === "existing" || session === "clean") writeFileSync(sessionFile, '{"type":"session","id":"s"}\n');
		writeFileSync(
			join(asyncDir, "status.json"),
			JSON.stringify({
				state: session === "running" ? "running" : "failed",
				...(session === "live" ? { pid: process.pid } : {}),
				steps: [session === "absent" || session === "stale" ? {} : { sessionFile }],
			}),
		);
		if (session === "status-gone") rmSync(join(asyncDir, "status.json"));
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
		if (session === "status-gone") {
			record.sessionFile = sessionFile;
			writeFileSync(sessionFile, '{"type":"session","id":"s"}\n');
		}
		writeRun(root, record);
		mkdirSync(record.worktree);
		git(record.worktree, "init", "-q", "-b", "main");
		if (session !== "clean" && session !== "live") writeFileSync(join(record.worktree, "dirty.txt"), "Uncommitted work.\n");
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
		if (session === "clean") {
			await assert.rejects(execution, /worktree is clean and no runner is alive.*Start a fresh run on branch 'run\/2026-11-08-resume-0000'/);
			assert.deepEqual(requests, []);
			assert.deepEqual(readRun(root, id), record);
			return;
		}
		if (session === "running") {
			await assert.rejects(execution, /Run is still running/);
			assert.deepEqual(requests, [{ method: "resume", params: { id: "sub-1", message: "Try again." } }]);
			assert.deepEqual(readRun(root, id), record);
			return;
		}
		const result = await execution;
		assert.deepEqual(requests, [
			session === "existing" || session === "status-gone"
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

async function runTool(t: TestContext, cwd: string, settings: Settings & { runs?: unknown } = {}) {
	const root = mkdtempSync(join(tmpdir(), "runs-start-"));
	const previousRoot = process.env.PI_RUNS_DIR;
	const previousChild = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_RUNS_DIR = root;
	process.env.PI_SUBAGENT_CHILD = "0";
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
		if (previousRoot === undefined) delete process.env.PI_RUNS_DIR;
		else process.env.PI_RUNS_DIR = previousRoot;
		if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previousChild;
	});
	const events = createEventBus();
	const { extensions, runtime, errors } = await loadExtensions(
		[fileURLToPath(new URL("./index.ts", import.meta.url))], cwd, events,
	);
	assert.deepEqual(errors, []);
	runtime.getSettings = () => settings;
	const models = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false });
	const runner = new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), new ModelRegistry(models));
	const tool = runner.getAllRegisteredTools().find((tool) => tool.definition.name === "run");
	assert.ok(tool);
	const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
	const requestSchema = Type.Object({ requestId: Type.String(), method: Type.String(), params: Type.Record(Type.String(), Type.Unknown()) });
	let rejection: string | undefined;
	events.on("subagents:rpc:v1:request", (raw) => {
		Value.Assert(requestSchema, raw);
		requests.push({ method: raw.method, params: raw.params });
		events.emit(
			`subagents:rpc:v1:reply:${raw.requestId}`,
			rejection
				? { success: false, error: { code: "invalid_model", message: rejection } }
				: { success: true, data: { details: { asyncId: "sub-1", asyncDir: join(root, "async") } } },
		);
	});
	return {
		root,
		requests,
		reject(message: string) { rejection = message; },
		execute(params: Record<string, unknown>) {
			return tool.definition.execute("test", params, undefined, undefined, runner.createToolContext("test", undefined));
		},
	};
}

const QUESTION = {
	model: "pi-sub-anthropic/claude-opus-5-5:medium",
	reading: ["~/.repos/legible/skills/scout-mode/SKILL.md"],
};

test("start resolves a role from the cwd repository and records its model and deduplicated reading", async (t) => {
	const repo = repoWithOneCommit();
	const target = repoWithOneCommit();
	t.after(() => {
		rmSync(repo, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	});
	mkdirSync(join(repo, "spec"));
	mkdirSync(join(repo, "nested"));
	const file = join(repo, "spec", "roles.json");
	const reading = join(homedir(), ".repos/legible/skills/scout-mode/SKILL.md");
	writeFileSync(file, JSON.stringify({ question: { ...QUESTION, reading: [...QUESTION.reading, reading, "/another.md", "/another.md"] } }));
	writeFileSync(join(target, "AGENTS.md"), "# Target rules\n");
	git(target, "add", "AGENTS.md");
	git(target, "commit", "-q", "-m", "add rules");
	const tool = await runTool(t, join(repo, "nested"), { runs: { roles: { question: { model: "ignored/model", reading: [] } } } });
	await tool.execute({
		action: "start", label: "question", role: "question", repo: target, ticket: "/ticket.md",
		task: `Read ${QUESTION.reading[0]}. Do not confuse /another.md.bak with required reading.`,
	});
	const [record] = listRuns(tool.root);
	assert.ok(record);
	assert.equal(record.role, "question");
	assert.equal(record.model, QUESTION.model);
	assert.equal(record.modelSource, file);
	assert.equal(tool.requests.length, 1);
	assert.equal(tool.requests[0].method, "spawn");
	assert.equal(tool.requests[0].params.model, QUESTION.model);
	const task = readFileSync(join(runDir(tool.root, record.id), "task.md"), "utf8");
	assert.equal(tool.requests[0].params.task, task.trimEnd());
	assert.equal(task.split(QUESTION.reading[0]).length - 1, 1);
	assert.ok(!task.includes(reading));
	assert.equal(task.split("/ticket.md").length - 1, 1);
	assert.ok(task.includes(`Required reading:\n- /another.md\n- /ticket.md\n- ${join(record.worktree, "AGENTS.md")}`));
});

for (const source of ["file", "settings"] as const) {
	test(`start uses ${source} roles and explicit model overrides only the model`, async (t) => {
		const repo = repoWithOneCommit();
		t.after(() => rmSync(repo, { recursive: true, force: true }));
		if (source === "file") {
			mkdirSync(join(repo, "spec"));
			writeFileSync(join(repo, "spec", "roles.json"), JSON.stringify({ question: QUESTION }));
		}
		const tool = await runTool(t, repo, { runs: { roles: { question: QUESTION } } });
		await tool.execute({ action: "start", label: "settings", role: "question", task: "Answer." });
		await tool.execute({ action: "start", label: "override", role: "question", model: "explicit/model:low", task: "Answer." });
		assert.equal(tool.requests[0].params.model, QUESTION.model);
		assert.equal(tool.requests[1].params.model, "explicit/model:low");
		for (const request of tool.requests) {
			assert.ok(String(request.params.task).includes(`Required reading:\n- ${join(homedir(), ".repos/legible/skills/scout-mode/SKILL.md")}`));
		}
		const record = listRuns(tool.root).find((record) => record.label === "override");
		assert.equal(record?.model, "explicit/model:low");
		assert.equal(record?.modelSource, "run start model parameter");
	});
}

test("invalid role configuration names the file and field and never falls back to settings", async (t) => {
	const repo = repoWithOneCommit();
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	mkdirSync(join(repo, "spec"));
	const file = join(repo, "spec", "roles.json");
	const tool = await runTool(t, repo, { runs: { roles: { question: QUESTION } } });
	for (const [config, field] of [
		[{ question: { ...QUESTION, reading: [42] } }, "/question/reading/0"],
		[{ question: { reading: [] } }, "model"],
		[{ question: { model: "", reading: [] } }, "/question/model"],
		[{ question: { ...QUESTION, reading: ["relative.md"] } }, "/question/reading/0"],
		[{ question: { ...QUESTION, typo: true } }, "typo"],
		[{}, "question"],
	] as const) {
		writeFileSync(file, JSON.stringify(config));
		await assert.rejects(
			tool.execute({ action: "start", label: "invalid", role: "question", task: "Answer." }),
			(error: Error) => error.message.includes(file) && error.message.includes(field),
		);
	}
	writeFileSync(file, "{");
	await assert.rejects(tool.execute({ action: "start", label: "invalid", role: "question", task: "Answer." }), /roles\.json.*field \//);
	assert.deepEqual(tool.requests, []);
	assert.deepEqual(listRuns(tool.root), []);
});

test("a rejected role model reports its source without substitution and preserves prepared work", async (t) => {
	const repo = repoWithOneCommit();
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	mkdirSync(join(repo, "spec"));
	const file = join(repo, "spec", "roles.json");
	writeFileSync(file, JSON.stringify({ question: QUESTION }));
	const tool = await runTool(t, repo);
	tool.reject("Unknown model; valid models: other/model.");
	await assert.rejects(
		tool.execute({
			action: "start", label: "rejected", role: "question", branch: "run/rejected", task: "Answer.",
			prepare: "printf prepared > prepared.txt",
		}),
		(error: Error) => ["question", QUESTION.model, file, "Unknown model"].every((part) => error.message.includes(part)),
	);
	assert.equal(tool.requests.length, 1);
	assert.equal(tool.requests[0].params.model, QUESTION.model);
	const worktree = String(tool.requests[0].params.cwd);
	assert.equal(readFileSync(join(worktree, "prepared.txt"), "utf8"), "prepared");
	assert.ok(git(repo, "branch", "--list", "run/rejected"));
});

test("settings errors name runs.roles fields and rejected settings models name their settings file", async (t) => {
	const repo = repoWithOneCommit();
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	mkdirSync(join(repo, ".pi"));
	const file = join(repo, ".pi", "settings.json");
	const settings = { runs: { roles: { question: QUESTION } } };
	writeFileSync(file, JSON.stringify(settings));
	const tool = await runTool(t, repo, settings);
	tool.reject("Rejected.");
	await assert.rejects(
		tool.execute({ action: "start", label: "settings rejection", role: "question", task: "Answer." }),
		(error: Error) => error.message.includes(file) && error.message.includes(QUESTION.model),
	);
	assert.throws(
		() => resolveRole(repo, "question", () => ({ runs: { roles: { question: { ...QUESTION, model: 42 } } } })),
		/\/runs\/roles\/question\/model/,
	);
});

test("start without a role keeps explicit and agent-default model behavior without reading roles", async (t) => {
	const repo = repoWithOneCommit();
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	mkdirSync(join(repo, "spec"));
	writeFileSync(join(repo, "spec", "roles.json"), "{invalid");
	const tool = await runTool(t, repo);
	await tool.execute({ action: "start", label: "default", task: "Answer." });
	await tool.execute({ action: "start", label: "explicit", model: "explicit/model:high", task: "Answer." });
	assert.ok(!("model" in tool.requests[0].params));
	assert.equal(tool.requests[1].params.model, "explicit/model:high");
});

test("runner liveness checks a terminal attempt's PID instead of its recorded outcome", () => {
	assert.equal(runnerAlive({ state: "failed" }), false);
	assert.equal(runnerAlive({ state: "failed", pid: process.pid }), true);
	assert.equal(runnerAlive({ state: "running", pid: 2_147_483_647 }), false);
	assert.equal(runnerAlive({ state: "running" }), true);
	if (existsSync("/proc/sys/kernel/random/boot_id")) {
		assert.equal(runnerAlive({ state: "running", pid: process.pid, bootId: "previous-boot" }), false);
	}
});

test("required reading does not repeat a ticket already named in the task or confuse a longer filename", () => {
	assert.equal(
		withRequiredReading("Read `/ticket.md` and /rules.md. Keep /new.md.bak.", ["/ticket.md", "/rules.md", "/new.md", "/new.md"]),
		"Read `/ticket.md` and /rules.md. Keep /new.md.bak.\n\nRequired reading:\n- /new.md",
	);
});
