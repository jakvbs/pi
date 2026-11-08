// The `run` tool: one scout-agent per run, on its own branch and worktree, with a record that outlives the session.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { lastAttempt, listRuns, newRunId, type RunRecord, readRun, runDir, runState, runsRoot, writeRun } from "./record.ts";
import { resolveRole, roleSchema, withRequiredReading } from "./roles.ts";
import { readStatus, runnerAlive, settleRun } from "./settle.ts";
import { callSubagents, launchDetails, SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentsMethod } from "./subagents-rpc.ts";
import { prepareWorktree, primaryCheckout, removeWorktree } from "./worktree.ts";

const AGENT = "scout-agent";
const PREPARE_TIMEOUT_MS = 15 * 60_000;

const parameters = Type.Object({
	action: StringEnum(["start", "list", "show", "steer", "stop", "resume"] as const),
	id: Type.Optional(Type.String({ description: "show, steer, stop, resume: run id, or a unique suffix of it." })),
	label: Type.Optional(Type.String({ description: "start: what will be true when this run lands, in about forty characters." })),
	task: Type.Optional(Type.String({ description: "start: the agent's task. Name required reading (skills, files) and the deliverable." })),
	repo: Type.Optional(Type.String({ description: "start: any path inside the repository; default is the session directory." })),
	branch: Type.Optional(
		Type.String({
			description: "start: work on this branch, reusing its worktree when it has one; omitted creates run/<id> from the checkout's HEAD.",
		}),
	),
	ticket: Type.Optional(Type.String({ description: "start: path of the ticket this run works on; appended to the task." })),
	role: Type.Optional(roleSchema),
	model: Type.Optional(
		Type.String({ description: "start: provider/model[:thinking]; overrides the role's model, otherwise the agent's default." }),
	),
	skills: Type.Optional(Type.Array(Type.String(), { description: "start: skills listed to the agent even outside its catalog." })),
	prepare: Type.Optional(Type.String({ description: "start: shell command run in a new worktree before the agent starts, e.g. npm ci." })),
	message: Type.Optional(Type.String({ description: "steer, resume: the message for the agent." })),
});

export default function (pi: ExtensionAPI) {
	// pi-subagents runs background children inside its runner, which sets this and loads ambient extensions. Only the
	// top-level session can own a run: pi-subagents delivers completions and allows resume only to the launching session.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	const root = runsRoot();

	pi.on("session_start", async () => {
		for (const record of listRuns(root)) if (runState(record) === "running") settleRun(root, record);
	});

	pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
		const { runId } = data as { runId?: string };
		const record = listRuns(root).find((run) => lastAttempt(run).subagentRunId === runId);
		if (record) settleRun(root, record);
	});

	pi.registerTool(
		defineTool({
			name: "run",
			label: "Run",
			description:
				"Starts and manages runs. A run is one scout-agent working in the background in its own git worktree on its own branch. " +
				`Its record (task, model, state, final report, commits, session) survives restarts under ${root}/<id>. ` +
				"start returns at once and you are woken when the agent ends; list and show settle ended runs; steer, stop and resume act on the agent.",
			promptSnippet: "Start a scout-agent on its own branch and worktree, and track it in a durable run record",
			parameters,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const text = await (async () => {
					switch (params.action) {
						case "start":
							return start(root, pi, params, ctx.cwd);
						case "list":
							return listRuns(root)
								.map((record) => settleRun(root, record))
								.map(summary)
								.join("\n") || "No runs.";
						case "show":
							return show(root, settleRun(root, find(root, params.id)));
						case "steer":
						case "stop": {
							const record = find(root, params.id);
							const data = await callSubagents(pi.events, params.action, {
								id: lastAttempt(record).subagentRunId,
								...(params.action === "steer" ? { message: required(params.message, "message") } : {}),
							});
							return data.text ?? `${params.action} sent to ${record.id}.`;
						}
						case "resume":
							return resume(root, pi, find(root, params.id), required(params.message, "message"));
					}
				})();
				return { content: [{ type: "text", text }], details: undefined };
			},
		}),
	);
}

async function start(root: string, pi: ExtensionAPI, params: Static<typeof parameters>, cwd: string): Promise<string> {
	const label = required(params.label, "label");
	const originalTask = required(params.task, "task");
	const roleConfig = params.role ? resolveRole(cwd, params.role, () => pi.getSettings()) : undefined;
	const model = params.model ?? roleConfig?.model;
	const selection = {
		...(params.role ? { role: params.role } : {}),
		...(model ? { model, modelSource: params.model ? "run start model parameter" : roleConfig?.source } : {}),
	};
	const checkout = params.repo ?? cwd;
	const repo = primaryCheckout(checkout);
	const id = newRunId(label, new Date());
	const dir = runDir(root, id);
	mkdirSync(dir, { recursive: true });
	const branch = params.branch ?? `run/${id}`;
	const { base, worktree, created } = prepareWorktree(checkout, branch, join(dir, "worktree"));
	const agentsFile = resolve(worktree, "AGENTS.md");
	const task = withRequiredReading(originalTask, [
		...(roleConfig?.reading ?? []),
		...(params.ticket ? [params.ticket] : []),
		...(existsSync(agentsFile) ? [agentsFile] : []),
	]);
	writeFileSync(join(dir, "task.md"), `${task}\n`);
	try {
		if (params.prepare && created) execSync(params.prepare, { cwd: worktree, stdio: "pipe", timeout: PREPARE_TIMEOUT_MS });
	} catch (error) {
		if (created) removeWorktree(repo, branch, worktree);
		throw error;
	}
	const launch = await launchAgent(
		pi,
		"spawn",
		{
			agent: AGENT,
			task,
			cwd: worktree,
			sessionDir: join(dir, "sessions"),
			context: "fresh",
			async: true,
			...(model ? { model } : {}),
			...(params.skills?.length ? { skill: params.skills } : {}),
		},
		{ ...selection, branch, worktree },
	);
	const record: RunRecord = {
		version: 1,
		id,
		label,
		...(params.ticket ? { ticket: params.ticket } : {}),
		repo,
		base,
		branch,
		worktree,
		agent: AGENT,
		...selection,
		skills: params.skills ?? [],
		attempts: [{ subagentRunId: launch.asyncId, asyncDir: launch.asyncDir, startedAt: new Date().toISOString() }],
		commits: [],
	};
	writeRun(root, record);
	return `Started run ${id} on branch ${branch} in ${worktree}. You will be woken when the agent ends; then read it with run show.`;
}

async function resume(root: string, pi: ExtensionAPI, record: RunRecord, message: string): Promise<string> {
	record = settleRun(root, record);
	const attempt = lastAttempt(record);
	const status = readStatus(attempt.asyncDir);
	if (
		!(status && runnerAlive(status)) &&
		!execFileSync("git", ["-C", record.worktree, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).trim()
	) {
		throw new Error(
			`Cannot resume run ${record.id}: its worktree is clean and no runner is alive. Start a fresh run on branch '${record.branch}'.`,
		);
	}
	const sessionFile = status?.steps?.[0]?.sessionFile;
	const dir = runDir(root, record.id);
	const launch =
		!status || runState(record) === "running" || (sessionFile && existsSync(sessionFile))
			? await launchAgent(pi, "resume", { id: attempt.subagentRunId, message }, record)
			: await launchAgent(
					pi,
					"spawn",
					{
						agent: record.agent,
						task: `${readFileSync(join(dir, "task.md"), "utf8").trimEnd()}\n\n${message}`,
						cwd: record.worktree,
						sessionDir: join(dir, "sessions"),
						context: "fresh",
						async: true,
						...(record.model ? { model: record.model } : {}),
						...(record.skills.length ? { skill: record.skills } : {}),
					},
					record,
				);
	writeRun(root, {
		...record,
		attempts: [...record.attempts, { subagentRunId: launch.asyncId, asyncDir: launch.asyncDir, startedAt: new Date().toISOString() }],
	});
	return `Resumed run ${record.id} (attempt ${record.attempts.length + 1}).`;
}

async function launchAgent(
	pi: ExtensionAPI,
	method: SubagentsMethod,
	params: Record<string, unknown>,
	selection: Pick<RunRecord, "role" | "model" | "modelSource" | "branch" | "worktree">,
) {
	try {
		return launchDetails(await callSubagents(pi.events, method, params));
	} catch (error) {
		const context = selection.model
			? `Run role '${selection.role ?? "none"}', model '${selection.model}', configured by ${selection.modelSource ?? "run record"}: `
			: "";
		throw new Error(
			`${context}${error instanceof Error ? error.message : String(error)} Work is preserved on branch '${selection.branch}' in ${selection.worktree}.`,
		);
	}
}

function summary(record: RunRecord): string {
	return `${record.id}  ${runState(record)}  ${record.label}  ${record.branch}  ${record.commits.length} commit(s)`;
}

function show(root: string, record: RunRecord): string {
	const outcome = lastAttempt(record).outcome;
	const reportFile = join(runDir(root, record.id), `report-${record.attempts.length}.md`);
	const lines = [
		`${record.id}: ${record.label}`,
		`state: ${runState(record)}${outcome?.reason ? ` (${outcome.reason})` : ""}`,
		`repo: ${record.repo}`,
		`branch: ${record.branch} (base ${record.base.slice(0, 12)})`,
		`worktree: ${record.worktree}`,
		`model: ${record.model ?? "agent default"}`,
		...(record.role ? [`role: ${record.role}`] : []),
		...(record.modelSource ? [`model source: ${record.modelSource}`] : []),
		...(record.ticket ? [`ticket: ${record.ticket}`] : []),
		`attempts: ${record.attempts.length}`,
		...(record.sessionFile ? [`session: ${record.sessionFile}`] : []),
		`commits:${record.commits.length > 0 ? `\n  ${record.commits.join("\n  ")}` : " none"}`,
	];
	if (existsSync(reportFile)) lines.push("", "report:", readFileSync(reportFile, "utf8").trimEnd());
	return lines.join("\n");
}

function find(root: string, id: string | undefined): RunRecord {
	const wanted = required(id, "id");
	const exact = readRun(root, wanted);
	if (exact) return exact;
	const matches = listRuns(root).filter((record) => record.id.endsWith(wanted));
	if (matches.length !== 1) throw new Error(`${matches.length === 0 ? "No" : "More than one"} run matches '${wanted}'.`);
	return matches[0];
}

function required(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`run needs '${name}' for this action.`);
	return value;
}
