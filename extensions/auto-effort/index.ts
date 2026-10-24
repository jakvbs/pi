import {
	type Api,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	hasApi,
	type Model,
	StringEnum,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { activeLevel, EFFORT_MESSAGE, type EffortChange, FAILING_TURNS_TO_RAISE, failingTurnStreak, raise } from "./policy.ts";

const TOOL_NAME = "set_thinking_effort";
const SUFFIX = "-auto";

/** Physical models whose effort travels in per-message markers, so changing it keeps the prompt cache. */
const PROVIDERS = ["pi-sub-anthropic", "anthropic"];
const MODELS = [
	{ id: "claude-fable-5-1", name: "Claude Fable 5.1" },
	{ id: "claude-opus-5-5", name: "Claude Opus 5.5" },
	{ id: "claude-opus-5", name: "Claude Opus 5" },
	{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
	{ id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
];

/** The physical model id behind a selected auto model, or undefined when another model is selected. */
function autoTarget(selected: Model<Api> | undefined): string | undefined {
	if (!selected?.id.endsWith(SUFFIX) || !PROVIDERS.includes(selected.provider)) return undefined;
	const id = selected.id.slice(0, -SUFFIX.length);
	return MODELS.some((model) => model.id === id) ? id : undefined;
}

/** The physical model behind a selected auto model, or undefined when another model is selected. */
function physicalModel(ctx: ExtensionContext, selected = ctx.model): Model<Api> | undefined {
	const id = autoTarget(selected);
	if (!selected || id === undefined) return undefined;
	const model = ctx.modelRegistry.find(selected.provider, id);
	if (!model) throw new Error(`Model ${selected.provider}/${id} is not in the catalog`);
	// Without markers a level change rewrites the request's top-level effort and drops the cache.
	if (!hasApi(model, "anthropic-messages") || model.compat?.supportsMidConvoEffort !== true) {
		throw new Error(`${selected.provider}/${id} does not take per-message effort, so auto effort would drop the prompt cache`);
	}
	return model;
}

/**
 * Auto effort: `<provider>/<model>-auto` routes every request to `<provider>/<model>` and chooses the
 * thinking effort itself. Each user message starts at the selected level. During the run the model
 * changes it with `set_thinking_effort`, and three consecutive turns with failing tool calls raise it
 * one step.
 *
 * A change is a custom message after the turn's tool results. It is the record the router reads, and
 * it is the new input that makes the provider's effort marker apply to the very next response; after
 * tool results alone the marker would wait for the next user message.
 */
export default function (pi: ExtensionAPI) {
	function changeEffort(change: EffortChange, why: string): void {
		pi.sendMessage(
			{
				customType: EFFORT_MESSAGE,
				content: `[auto effort] Thinking effort for the next steps: ${change.level}. ${why}`,
				display: true,
				details: change,
			},
			// Queued while the run streams and appended after the turn's tool results.
			{ triggerTurn: false },
		);
	}

	for (const provider of PROVIDERS) {
		for (const { id, name } of MODELS) {
			pi.registerVirtualModel({
				provider,
				id: `${id}${SUFFIX}`,
				name: `${name} (auto effort)`,
				thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
				route(request, ctx) {
					const model = physicalModel(ctx, request.model);
					if (!model) throw new Error(`${request.model.provider}/${request.model.id} is not an auto effort model`);
					const level =
						request.reason === "direct"
							? request.thinkingLevel
							: activeLevel(ctx.sessionManager.getBranch(), request.thinkingLevel);
					return { model, thinkingLevel: level };
				},
			});
		}
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Thinking effort",
		description:
			"Set the thinking effort for the following steps of the current task. It applies from the next response until the user's next message, which starts again at the level the user selected.",
		promptSnippet: "Change the thinking effort for the following steps of the current task",
		promptGuidelines: [
			`Use ${TOOL_NAME} when the work changes phase: low or medium for routine steps such as applying a planned edit, renaming, or reading files; xhigh or max before debugging a failure you do not understand, designing, or after the user says an earlier attempt was wrong.`,
			`Call ${TOOL_NAME} in the same response as the first tool call of the new phase, not on its own.`,
		],
		parameters: Type.Object({
			level: StringEnum(["low", "medium", "high", "xhigh", "max"] as const),
			reason: Type.String({ description: "Why the next steps need this effort, in a few words" }),
		}),
		defaultActive: false,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const model = physicalModel(ctx);
			if (!model) throw new Error("Thinking effort can only be changed with an auto effort model selected");
			const level = clampThinkingLevel(model, params.level);
			const current = activeLevel(ctx.sessionManager.getBranch(), pi.getThinkingLevel());
			if (level === current) {
				return { content: [{ type: "text", text: `Thinking effort stays ${current}.` }], details: undefined };
			}
			changeEffort({ level, reason: params.reason }, `Requested by the model: ${params.reason}`);
			return { content: [{ type: "text", text: `Thinking effort is ${level} from the next response.` }], details: undefined };
		},
	});

	pi.on("turn_end", (event, ctx) => {
		// Without tool results the run ends here and the next user message resets the effort anyway.
		if (event.toolResults.length === 0) return;
		const model = physicalModel(ctx);
		if (!model) return;
		const message = event.message;
		if (message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.name === TOOL_NAME)) {
			return;
		}
		const branch = ctx.sessionManager.getBranch();
		if (failingTurnStreak(branch) < FAILING_TURNS_TO_RAISE) return;
		const level = raise(activeLevel(branch, pi.getThinkingLevel()), getSupportedThinkingLevels(model));
		if (level === undefined) return;
		const reason = `tool calls failed in ${FAILING_TURNS_TO_RAISE} consecutive turns`;
		changeEffort({ level, reason }, `Raised automatically: ${reason}.`);
	});

	function syncTool(ctx: ExtensionContext): void {
		const wanted = autoTarget(ctx.model) !== undefined;
		const active = pi.getActiveTools();
		if (active.includes(TOOL_NAME) === wanted) return;
		pi.setActiveTools(wanted ? [...active, TOOL_NAME] : active.filter((name) => name !== TOOL_NAME));
	}
	pi.on("session_start", (_event, ctx) => syncTool(ctx));
	pi.on("model_select", (_event, ctx) => syncTool(ctx));
}
