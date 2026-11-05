import type { ExtensionAPI, ExtensionContext, TurnHandoff } from "@earendil-works/pi-coding-agent";
import { TURN_HANDOFF_ENTRY_TYPE } from "@earendil-works/pi-coding-agent";
import { type HandoffConfig, loadConfig, SETTINGS_KEY } from "./config.ts";
import { contentText, toStep } from "./steps.ts";
import { type HandoffRequest, TurnTracker } from "./tracker.ts";
import { type HandoffModel, writeHandoff } from "./writer.ts";

/**
 * Turn handoffs: while a turn runs, a small model writes what the turn is for, what it has done and what it does next,
 * and pi shows it below the turn's fold row; when a turn that had one ends, the model writes one sentence on what it
 * did, which follows the row's counts. Only interactive sessions get handoffs; each is a `turn-handoff` entry the
 * session keeps and the agent's model never sees.
 */
export default function (pi: ExtensionAPI) {
	let config: HandoffConfig | undefined;
	let tracker: TurnTracker | undefined;
	const requests = new Map<number, AbortController>();
	const warnings = new Set<string>();

	/** Warn once per session about each problem, so a model that keeps failing does not flood the transcript. */
	function warn(ctx: ExtensionContext, message: string): void {
		if (warnings.has(message)) return;
		warnings.add(message);
		ctx.ui.notify(`Turn handoff: ${message}`, "warning");
	}

	function resolveModel(ctx: ExtensionContext): HandoffModel | undefined {
		const configured = config?.model;
		if (!configured) return undefined;
		const model = ctx.modelRegistry.find(configured.provider, configured.id);
		if (!model) warn(ctx, `model ${configured.provider}/${configured.id} is not in the model list`);
		return model && { model, thinking: configured.thinking };
	}

	/** Stop the running request the end of a turn makes stale. */
	function abortPending(): void {
		const id = tracker?.pendingId();
		if (id !== undefined) requests.get(id)?.abort();
	}

	async function send(request: HandoffRequest | undefined, ctx: ExtensionContext): Promise<void> {
		const owner = tracker;
		const handoffModel = resolveModel(ctx);
		if (!request || !owner) return;
		if (!handoffModel) {
			owner.failed(request, Date.now());
			return;
		}
		const controller = new AbortController();
		requests.set(request.id, controller);
		try {
			const { handoff } = await writeHandoff(request, handoffModel, ctx.modelRegistry, controller.signal);
			const running = handoff.kind === "running" ? handoff : undefined;
			if (owner === tracker && owner.written(request, running, Date.now())) {
				pi.appendEntry<TurnHandoff>(TURN_HANDOFF_ENTRY_TYPE, handoff);
			}
		} catch (error) {
			owner.failed(request, Date.now());
			if (!controller.signal.aborted && owner === tracker) {
				warn(ctx, error instanceof Error ? error.message : String(error));
			}
		} finally {
			requests.delete(request.id);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		for (const controller of requests.values()) controller.abort();
		warnings.clear();
		config = loadConfig(ctx.cwd);
		tracker = ctx.hasUI && config.model ? new TurnTracker(config) : undefined;
		if (ctx.hasUI && !config.model) {
			warn(ctx, `set "${SETTINGS_KEY}": { "model": { "provider": "...", "id": "..." } } in settings.json`);
		}
	});

	pi.on("session_shutdown", () => {
		for (const controller of requests.values()) controller.abort();
		tracker = undefined;
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "user" || !tracker) return;
		abortPending();
		tracker.userMessage(contentText(event.message.content), Date.now());
	});

	pi.on("agent_start", () => {
		tracker?.runStarted(Date.now());
	});

	pi.on("turn_end", (event, ctx) => {
		const message = event.message;
		if (!tracker || message.role !== "assistant") return;
		const step = toStep(message, event.toolResults);
		// The model call runs beside the agent, which does not wait for it.
		if (message.stopReason === "toolUse") {
			void send(tracker.step(step, Date.now()), ctx);
			return;
		}
		abortPending();
		if (message.stopReason === "stop" || message.stopReason === "length") void send(tracker.reply(step), ctx);
		else tracker.runEnded();
	});

	pi.on("agent_end", () => {
		if (!tracker) return;
		abortPending();
		tracker.runEnded();
	});
}
