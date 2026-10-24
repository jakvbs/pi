import { randomUUID } from "node:crypto";
import type { AgentContext, AgentLoopConfig, AgentMessage, agentLoop, StreamFn } from "@earendil-works/pi-agent-core";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { debugLog } from "../debug-log.ts";
import { logAgentStreamError } from "./stream-errors.ts";

/** The part of Pi's model registry that memory workers send requests through. */
export type WorkerModelRegistry = Pick<ModelRegistry, "streamSimple">;

/** The last assistant turn of a worker conversation that ended with an error or an abort. */
export interface WorkerStreamError {
	stopReason: string;
	errorMessage?: string;
}

interface WorkerConversation {
	stage: "observer" | "reflector" | "dropper";
	registry: WorkerModelRegistry;
	loop: typeof agentLoop;
	prompts: AgentMessage[];
	context: AgentContext;
	config: AgentLoopConfig;
	signal: AbortSignal | undefined;
}

/**
 * Runs one worker conversation to its end. Results arrive through the worker's tools; the
 * conversation reports only its last failed assistant turn, which the worker turns into an error
 * when the tools collected nothing.
 *
 * Requests go through Pi's model registry, which selects the provider, including providers
 * registered by extensions, authenticates each request when it is sent and applies the session's
 * timeouts, provider retries, client identity and `before_provider_headers` handlers, so workers
 * never hold credentials. Payload and response hooks (`before_provider_request`,
 * `after_provider_response`) belong to session requests and do not see worker requests. The conversation gets its own routing id,
 * as Pi's summarization requests do; opencode, for one, rejects requests without it. The id is
 * never reused, so the provider resources Pi keeps for it, such as an OpenAI Codex WebSocket, are
 * released when the conversation ends.
 */
export async function runWorkerConversation(conversation: WorkerConversation): Promise<WorkerStreamError | undefined> {
	const { stage, registry, loop, prompts, context, config, signal } = conversation;
	const sessionId = randomUUID();
	const streamFn: StreamFn = (model, llmContext, options) =>
		registry.streamSimple(model, llmContext, { ...options, sessionId });
	try {
		const stream = loop(prompts, context, config, signal, streamFn);
		let streamError: WorkerStreamError | undefined;
		for await (const event of stream) {
			logAgentStreamError(stage, event);
			if (event.type !== "message_end" || event.message.role !== "assistant") continue;
			const { stopReason, errorMessage } = event.message;
			if (stopReason === "error" || stopReason === "aborted") streamError = { stopReason, errorMessage };
		}
		await stream.result();
		return streamError;
	} finally {
		releaseConversation(stage, sessionId);
	}
}

function releaseConversation(stage: WorkerConversation["stage"], sessionId: string): void {
	try {
		cleanupSessionResources(sessionId);
	} catch (error) {
		// A failed release must not replace the conversation's own result or error.
		debugLog(`${stage}.release_error`, { errorMessage: error instanceof Error ? error.message : String(error) });
	}
}
