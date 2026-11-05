// Asks the handoff model for a turn's handoff: the request as text, the prompt, and the tool call it answers with.
import { randomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	cleanupSessionResources,
	type Model,
	type ThinkingLevel,
	type Tool,
} from "@earendil-works/pi-ai";
import type { ModelRegistry, TurnHandoff } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HandoffRequest, Step } from "./tracker.ts";

/** The model that writes handoffs and how hard it thinks; "off" sends no reasoning setting. */
export interface HandoffModel {
	model: Model<Api>;
	thinking: ThinkingLevel | "off";
}

/** A handoff the model wrote, with what the request cost. */
export interface WrittenHandoff {
	handoff: TurnHandoff;
	message: AssistantMessage;
}

export const SYSTEM_PROMPT = `You write a handoff of one turn of a coding agent. A person watches the turn in a terminal and reads the handoff instead of every tool call. The handoff must let them understand where the turn is in a few seconds, and let them take it over.

You get the user's message that started the turn, the previous handoff of this turn if there is one, and the steps of the agent since that handoff: its thinking, its text, its tool calls and their results, all cut short. Call the tool once with the handoff, then stop.

Language. Write in the language of the user's message. If the message has no clear language, use the language of the previous handoff. Keep identifiers, file paths, commands, code, error messages and quoted words exactly as they are, not translated.

Style. Follow the writing rules of ASD-STE100 Simplified Technical English in the language you write in:
- One topic in each sentence. Write complete sentences; do not drop verbs, articles or other small words.
- At most 20 words in a sentence about what to do next, at most 25 words in a sentence that describes.
- Use the active voice, and name who acts when it is not clear.
- Use common, simple words. Use one word for one meaning, and the same word for the same thing in each handoff.
- No filler, no guesses, no praise, no hedging.

Content. Only facts from the input. Say results, not activity: "src/auth.ts:45 compares the token without the prefix" is better than "read some files".`;

const RUNNING_RULES = `Fields of write_handoff. Each field shows on one terminal line of about 100 characters, and the terminal cuts off the rest, so keep to the word limits:
- goal: one sentence of at most 12 words on what the user wants from this turn. Keep the previous goal unless the user's message or the work changed it.
- done: at most 20 words in one or two sentences, on the most important results so far: what the agent found, changed or verified. Merge them with the previous "done" and drop details that no longer matter.
- next: one sentence of at most 14 words on what the agent does now or next, or on what stops it (a failing check, a missing permission, a question to the user).
Name a file, command or commit only when the reader needs it.`;

const FINISHED_RULES = `The turn has ended; its reply comes after the steps. Fields of write_summary:
- summary: one sentence of at most 15 words on what the whole turn did and with what result, in the past tense. The previous handoff says what the turn did before the steps; cover both, not only the steps. It shows after the turn's counts on one terminal line, and the person sees the reply below it, so do not repeat the reply; say what the agent changed or checked to get there.`;

const RUNNING_TOOL: Tool = {
	name: "write_handoff",
	description: "Write the handoff of the running turn.",
	parameters: Type.Object({
		goal: Type.String({ description: "What the user wants from this turn, in one sentence." }),
		done: Type.String({ description: "The most important results so far, in one or two sentences." }),
		next: Type.String({ description: "What the agent does now or next, or what stops it, in one sentence." }),
	}),
};

const FINISHED_TOOL: Tool = {
	name: "write_summary",
	description: "Write the summary of the finished turn.",
	parameters: Type.Object({
		summary: Type.String({ description: "What the turn did and with what result, in one sentence." }),
	}),
};

/** How much of each part of the input the model gets; a step's parts are cut to these lengths. */
const LIMITS = { goal: 3000, thinking: 800, text: 800, args: 300, result: 500, reply: 1500, steps: 24000 };

/** Ask the model for the handoff of a request; throws when the request fails or the model writes none. */
export async function writeHandoff(
	request: HandoffRequest,
	handoffModel: HandoffModel,
	registry: Pick<ModelRegistry, "streamSimple">,
	signal?: AbortSignal,
): Promise<WrittenHandoff> {
	const tool = request.kind === "running" ? RUNNING_TOOL : FINISHED_TOOL;
	// The request gets its own routing id, as Pi's summaries do; some providers reject requests without one.
	const sessionId = randomUUID();
	try {
		const stream = registry.streamSimple(
			handoffModel.model,
			{
				systemPrompt: `${SYSTEM_PROMPT}\n\n${request.kind === "running" ? RUNNING_RULES : FINISHED_RULES}`,
				messages: [{ role: "user", content: renderRequest(request), timestamp: Date.now() }],
				tools: [tool],
			},
			{
				maxTokens: 2048,
				signal,
				sessionId,
				...(handoffModel.thinking === "off" ? {} : { reasoning: handoffModel.thinking }),
			},
		);
		const message = await stream.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? message.stopReason);
		}
		const call = message.content.find((part) => part.type === "toolCall" && part.name === tool.name);
		const handoff = call?.type === "toolCall" ? parseArguments(request, call.arguments) : undefined;
		if (!handoff) throw new Error(`the model did not call ${tool.name} with every field`);
		return { handoff, message };
	} finally {
		cleanupSessionResources(sessionId);
	}
}

/** The handoff in the tool call's arguments, each field on one line; undefined when a field is missing or empty. */
function parseArguments(request: HandoffRequest, args: Record<string, unknown>): TurnHandoff | undefined {
	const field = (name: string): string | undefined => {
		const value = args[name];
		const line = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
		return line || undefined;
	};
	if (request.kind === "finished") {
		const summary = field("summary");
		return summary ? { kind: "finished", summary } : undefined;
	}
	const goal = field("goal");
	const done = field("done");
	const next = field("next");
	return goal && done && next ? { kind: "running", goal, done, next } : undefined;
}

/** The request as the model reads it: the user's message, the previous handoff, the steps, and the reply. */
export function renderRequest(request: HandoffRequest): string {
	const parts = [`<user_message>\n${cut(request.goal, LIMITS.goal)}\n</user_message>`];
	if (request.previous) {
		const { goal, done, next } = request.previous;
		parts.push(`<previous_handoff>\ngoal: ${goal}\ndone: ${done}\nnext: ${next}\n</previous_handoff>`);
	}
	parts.push(`<steps>\n${renderSteps(request.steps)}\n</steps>`);
	if (request.kind === "finished") parts.push(`<reply>\n${cut(request.reply, LIMITS.reply)}\n</reply>`);
	return parts.join("\n\n");
}

/** The steps, oldest first; when they are too long, the oldest go and a line says how many. */
function renderSteps(steps: readonly Step[]): string {
	const rendered = steps.map(renderStep);
	if (rendered.length === 0) return "";
	// The newest step always goes, even when it alone is too long.
	let first = rendered.length - 1;
	let length = rendered[first].length;
	while (first > 0 && length + rendered[first - 1].length <= LIMITS.steps) length += rendered[--first].length;
	const omitted = first > 0 ? [`(${first} earlier steps left out)`] : [];
	return [...omitted, ...rendered.slice(first)].join("\n\n");
}

function renderStep(step: Step): string {
	const lines = [`[step ended ${new Date(step.at).toISOString()}]`];
	if (step.thinking.trim()) lines.push(`thinking: ${cut(step.thinking, LIMITS.thinking)}`);
	if (step.text.trim()) lines.push(`text: ${cut(step.text, LIMITS.text)}`);
	for (const call of step.calls) {
		lines.push(`tool ${call.name} ${cut(call.args, LIMITS.args)}`);
		lines.push(`${call.isError ? "error" : "result"}: ${cut(call.result, LIMITS.result)}`);
	}
	return lines.join("\n");
}

/** The text cut to a length, with a mark that says how much was left out. */
function cut(text: string, length: number): string {
	const trimmed = text.trim();
	return trimmed.length <= length
		? trimmed
		: `${trimmed.slice(0, length)} [... ${trimmed.length - length} more chars]`;
}
