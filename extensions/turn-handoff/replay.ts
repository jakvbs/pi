// Replays recorded turns through the handoff model as the extension would, and measures the handoffs it writes.
//
//   npm run replay -- --model pi-sub-anthropic/claude-sonnet-5-5 [--thinking off] [--judge provider/id]
//                     [--turns 6] [--lang pl|en|any] [--provider pi-sub-anthropic] [session.jsonl ...]
//
// Without files it reads the newest sessions under ~/.pi/agent/sessions. It sends recorded turns only to the provider
// that answered them (--provider, default the handoff model's), so no session leaves the boundary it was recorded in.
// The report goes to a new directory under $TMPDIR, whose path the script prints.
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	getAgentDir,
	ModelRegistry,
	type RunningTurnHandoff,
	SessionManager,
	type TurnHandoff,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { contentText, toStep } from "./steps.ts";
import { type HandoffRequest, type Step, TurnTracker } from "./tracker.ts";
import { type HandoffModel, renderRequest, writeHandoff } from "./writer.ts";

const CADENCE = { everyMs: 60_000, everyToolCalls: 8 };

/** One recorded event of a turn, in the order the extension would see it. */
type TurnEvent = { type: "user"; text: string; at: number } | { type: "step"; step: Step; reply: boolean };

interface RecordedTurn {
	file: string;
	goal: string;
	events: TurnEvent[];
	providers: Set<string>;
}

interface Measured {
	request: HandoffRequest;
	handoff?: TurnHandoff;
	error?: string;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	judge?: Judgement;
}

interface Judgement {
	faithful: number;
	current: number;
	useful: number;
	style: number;
	notes: string;
}

function findModel(registry: ModelRegistry, ref: string): Model<Api> {
	const [provider, ...id] = ref.split("/");
	const model = registry.find(provider, id.join("/"));
	if (!model) throw new Error(`model ${ref} is not in the model list`);
	return model;
}

function thinkingLevel(value: string | undefined): HandoffModel["thinking"] {
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
	const level = levels.find((candidate) => candidate === value);
	if (!level) throw new Error(`--thinking must be one of ${levels.join(", ")}`);
	return level;
}

/** The newest session files, newest first. */
function newestSessions(limit: number): string[] {
	const root = join(getAgentDir(), "sessions");
	const files = readdirSync(root, { recursive: true, encoding: "utf-8" })
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(root, name));
	return files
		.map((file) => ({ file, mtime: statSync(file).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, limit)
		.map(({ file }) => file);
}

/** The turns of a session file's current branch: a user message and the steps up to its reply. */
function readTurns(file: string): RecordedTurn[] {
	const entries = readFileSync(file, "utf-8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line): { id?: string; parentId?: string | null; type?: string; message?: AgentMessage }[] => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
	const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
	const branch = [];
	for (let entry = entries.at(-1); entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
		branch.unshift(entry);
	}

	const turns: RecordedTurn[] = [];
	let turn: RecordedTurn | undefined;
	let pending: { message: Extract<AgentMessage, { role: "assistant" }>; results: ToolResultMessage[] } | undefined;
	const flush = () => {
		if (!pending || !turn) return;
		const reply = pending.message.stopReason === "stop" || pending.message.stopReason === "length";
		turn.events.push({ type: "step", step: toStep(pending.message, pending.results), reply });
		turn.providers.add(pending.message.provider);
		pending = undefined;
	};
	for (const entry of branch) {
		const message = entry.type === "message" ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "user") {
			flush();
			turn = { file, goal: contentText(message.content), events: [], providers: new Set() };
			turn.events.push({ type: "user", text: turn.goal, at: message.timestamp });
			turns.push(turn);
		} else if (message.role === "assistant") {
			flush();
			pending = { message, results: [] };
		} else if (message.role === "toolResult") {
			pending?.results.push(message);
		}
	}
	flush();
	return turns;
}

/** Run a turn through the tracker, writing each handoff it asks for with `write`, in order. */
async function replayTurn(
	turn: RecordedTurn,
	write: (request: HandoffRequest) => Promise<Measured>,
): Promise<Measured[]> {
	const tracker = new TurnTracker(CADENCE);
	const measured: Measured[] = [];
	const send = async (request: HandoffRequest | undefined, now: number) => {
		if (!request) return;
		const item = await write(request);
		measured.push(item);
		if (item.handoff) tracker.written(request, item.handoff.kind === "running" ? item.handoff : undefined, now);
		else tracker.failed(request, now);
	};
	for (const event of turn.events) {
		if (event.type === "user") {
			tracker.userMessage(event.text, event.at);
			tracker.runStarted(event.at);
		} else if (event.reply) {
			await send(tracker.reply(event.step), event.step.at);
		} else {
			await send(tracker.step(event.step, event.step.at), event.step.at);
		}
	}
	return measured;
}

async function hasHandoffs(turn: RecordedTurn): Promise<boolean> {
	return (await replayTurn(turn, async (request) => placeholder(request))).length > 0;
}

function placeholder(request: HandoffRequest): Measured {
	const handoff: RunningTurnHandoff = { kind: "running", goal: "", done: "", next: "" };
	return { request, handoff, latencyMs: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
}

async function measure(
	request: HandoffRequest,
	handoffModel: HandoffModel,
	registry: ModelRegistry,
): Promise<Measured> {
	const started = Date.now();
	try {
		const { handoff, message } = await writeHandoff(request, handoffModel, registry);
		const { usage } = message;
		return {
			request,
			handoff,
			latencyMs: Date.now() - started,
			inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
			outputTokens: usage.output,
			cost: usage.cost.total,
		};
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		return { request, error: text, latencyMs: Date.now() - started, inputTokens: 0, outputTokens: 0, cost: 0 };
	}
}

const JUDGE_PROMPT = `You grade a handoff that a model wrote about one turn of a coding agent, for a person who watches the turn. You get the input the model got and the handoff. Score each criterion from 1 (bad) to 5 (good), then call the tool once.
- faithful: every claim follows from the input; nothing is invented or wrong.
- current: it reflects the latest steps, not only the early ones.
- useful: a person who reads only this can tell where the turn is and could take it over.
- style: short complete sentences (ASD-STE100 rules: one topic per sentence, at most 20-25 words, simple words, active voice), in the language of the user's message, with identifiers kept as they are.
In notes, name the worst problem in one sentence, in English.`;

async function judge(item: Measured, model: Model<Api>, registry: ModelRegistry): Promise<Judgement | undefined> {
	const scores = Type.Object({
		faithful: Type.Number(),
		current: Type.Number(),
		useful: Type.Number(),
		style: Type.Number(),
		notes: Type.String(),
	});
	const message = await registry
		.streamSimple(
			model,
			{
				systemPrompt: JUDGE_PROMPT,
				messages: [
					{
						role: "user",
						content: `<input>\n${renderRequest(item.request)}\n</input>\n\n<handoff>\n${JSON.stringify(item.handoff)}\n</handoff>`,
						timestamp: Date.now(),
					},
				],
				tools: [{ name: "score", description: "Score the handoff.", parameters: scores }],
			},
			{ maxTokens: 1024 },
		)
		.result();
	const call = message.content.find((part) => part.type === "toolCall");
	if (call?.type !== "toolCall") return undefined;
	const { faithful, current, useful, style, notes } = call.arguments;
	return {
		faithful: Number(faithful),
		current: Number(current),
		useful: Number(useful),
		style: Number(style),
		notes: String(notes),
	};
}

/** "pl", "en" or "other", from how many common short words of each language the text has. */
function detectLanguage(text: string): string {
	const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
	const polish = new Set([
		"i",
		"w",
		"z",
		"na",
		"się",
		"nie",
		"do",
		"że",
		"jest",
		"to",
		"po",
		"czy",
		"jak",
		"dla",
		"co",
		"ten",
		"tak",
		"oraz",
		"albo",
		"mi",
	]);
	const english = new Set([
		"the",
		"and",
		"to",
		"of",
		"in",
		"is",
		"for",
		"with",
		"it",
		"that",
		"this",
		"on",
		"be",
		"are",
		"what",
		"how",
	]);
	const pl = words.filter((word) => polish.has(word)).length + (/[ąćęłńóśźż]/i.test(text) ? 2 : 0);
	const en = words.filter((word) => english.has(word)).length;
	if (pl === 0 && en === 0) return "other";
	return pl >= en ? "pl" : "en";
}

/** Sentences of a field and their word counts. */
function sentenceLengths(text: string): number[] {
	return text
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => (sentence.match(/\S+/g) ?? []).length)
		.filter((count) => count > 0);
}

/** Names in the handoff that look like paths, files or code identifiers and do not occur in the model's input. */
function ungrounded(handoff: TurnHandoff, input: string): string[] {
	const text = handoff.kind === "running" ? `${handoff.goal} ${handoff.done} ${handoff.next}` : handoff.summary;
	const names = text.match(/`[^`]+`|[\w@-]+(?:[./:][\w@-]+)+|\w+_\w+|[a-z]+[A-Z]\w*/g) ?? [];
	return [...new Set(names.map((name) => name.replace(/^`|`$/g, "").replace(/[.:]$/, "")))].filter(
		(name) => !input.includes(name),
	);
}

function fields(handoff: TurnHandoff): [string, string][] {
	return handoff.kind === "running"
		? [
				["goal", handoff.goal],
				["done", handoff.done],
				["next", handoff.next],
			]
		: [["summary", handoff.summary]];
}

function report(
	results: { turn: RecordedTurn; measured: Measured[] }[],
	model: string,
	judgeRef: string | undefined,
): string {
	const all = results.flatMap(({ measured }) => measured);
	const written = all.filter((item) => item.handoff);
	const lines: string[] = [`# Turn handoff replay`, "", `Model: ${model}. Judge: ${judgeRef ?? "none"}.`, ""];
	const latencies = written.map((item) => item.latencyMs).sort((a, b) => a - b);
	const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * p))] ?? 0;
	let longSentences = 0;
	let longFields = 0;
	let wrongLanguage = 0;
	let ungroundedNames = 0;
	for (const item of written) {
		if (!item.handoff) continue;
		const input = renderRequest(item.request);
		for (const [name, value] of fields(item.handoff)) {
			const limit = name === "next" ? 20 : 25;
			longSentences += sentenceLengths(value).filter((count) => count > limit).length;
			if (item.handoff.kind === "running" && value.length > 120) longFields++;
		}
		if (
			detectLanguage(
				fields(item.handoff)
					.map(([, value]) => value)
					.join(" "),
			) !== detectLanguage(item.request.goal)
		) {
			wrongLanguage++;
		}
		ungroundedNames += ungrounded(item.handoff, input).length;
	}
	const judged = written.flatMap((item) => (item.judge ? [item.judge] : []));
	const mean = (pick: (j: Judgement) => number) =>
		judged.length ? (judged.reduce((sum, j) => sum + pick(j), 0) / judged.length).toFixed(2) : "n/a";
	lines.push(
		`Turns: ${results.length}. Requests: ${all.length} (${all.filter((item) => item.request.kind === "running").length} running, ${all.filter((item) => item.request.kind === "finished").length} finished). Failed: ${all.length - written.length}.`,
		`Latency p50 ${pct(0.5)} ms, p90 ${pct(0.9)} ms. Tokens per request: ${Math.round(sum(written, (i) => i.inputTokens) / Math.max(1, written.length))} in, ${Math.round(sum(written, (i) => i.outputTokens) / Math.max(1, written.length))} out. Cost: $${sum(written, (i) => i.cost).toFixed(4)}.`,
		`Sentences over the STE limit (20 words for next, 25 otherwise): ${longSentences}. Running fields over 120 characters: ${longFields}. Handoffs not in the user's language: ${wrongLanguage}. Names not found in the input: ${ungroundedNames}.`,
		`Judge means (1-5): faithful ${mean((j) => j.faithful)}, current ${mean((j) => j.current)}, useful ${mean((j) => j.useful)}, style ${mean((j) => j.style)}.`,
		"",
	);
	for (const { turn, measured } of results) {
		lines.push(`## ${turn.goal.slice(0, 100).replace(/\s+/g, " ")}`, "", `Session: ${turn.file}`, "");
		for (const item of measured) {
			const steps = item.request.steps.length;
			lines.push(`### ${item.request.kind} handoff after ${steps} new steps (${item.latencyMs} ms)`, "");
			if (!item.handoff) {
				lines.push(`Failed: ${item.error}`, "");
				continue;
			}
			for (const [name, value] of fields(item.handoff)) {
				lines.push(
					`- ${name} (${value.length} chars, sentences of ${sentenceLengths(value).join(", ")} words): ${value}`,
				);
			}
			const names = ungrounded(item.handoff, renderRequest(item.request));
			if (names.length) lines.push(`- names not in the input: ${names.join(", ")}`);
			if (item.judge) {
				const j = item.judge;
				lines.push(
					`- judge: faithful ${j.faithful}, current ${j.current}, useful ${j.useful}, style ${j.style}. ${j.notes}`,
				);
			}
			lines.push("");
		}
	}
	return lines.join("\n");
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
	return items.reduce((total, item) => total + pick(item), 0);
}

/** JSON without the steps' full text, which the session files already hold. */
function replacer(key: string, value: unknown): unknown {
	if (key === "providers" && value instanceof Set) return [...value];
	if (key === "steps" && Array.isArray(value)) return value.length;
	if (key === "events") return undefined;
	return value;
}

/** Replay the chosen turns and write the report. */
async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			model: { type: "string" },
			thinking: { type: "string", default: "off" },
			judge: { type: "string" },
			turns: { type: "string", default: "6" },
			lang: { type: "string", default: "pl" },
			provider: { type: "string" },
		},
	});
	if (!values.model) throw new Error("--model provider/id is required");

	const outDir = mkdtempSync(join(tmpdir(), "turn-handoff-replay-"));
	const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory(), cwd: outDir });
	try {
		const registry = new ModelRegistry(session.modelRuntime);
		const handoffModel: HandoffModel = {
			model: findModel(registry, values.model),
			thinking: thinkingLevel(values.thinking),
		};
		const judgeModel = values.judge ? findModel(registry, values.judge) : undefined;
		const provider = values.provider ?? handoffModel.model.provider;

		const files = positionals.length > 0 ? positionals : newestSessions(400);
		const candidates = files
			.flatMap(readTurns)
			.filter((turn) => turn.providers.size > 0 && [...turn.providers].every((p) => p === provider))
			.filter((turn) => values.lang === "any" || detectLanguage(turn.goal) === values.lang);
		const turns: RecordedTurn[] = [];
		for (const turn of await Promise.all(
			candidates.map(async (turn) => ((await hasHandoffs(turn)) ? turn : undefined)),
		)) {
			if (turn && turns.length < Number(values.turns) && !turns.some((other) => other.file === turn.file)) {
				turns.push(turn);
			}
		}

		const results: { turn: RecordedTurn; measured: Measured[] }[] = [];
		for (const turn of turns) {
			process.stderr.write(`replaying ${turn.file}: ${turn.goal.slice(0, 60).replace(/\s+/g, " ")}\n`);
			const measured = await replayTurn(turn, (request) => measure(request, handoffModel, registry));
			if (judgeModel) {
				for (const item of measured) if (item.handoff) item.judge = await judge(item, judgeModel, registry);
			}
			results.push({ turn, measured });
		}

		writeFileSync(join(outDir, "results.json"), JSON.stringify(results, replacer, 2));
		writeFileSync(join(outDir, "report.md"), report(results, values.model, values.judge));
		process.stdout.write(`${join(outDir, "report.md")}\n`);
	} finally {
		session.dispose();
	}
}

await main();
