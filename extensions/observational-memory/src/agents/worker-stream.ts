import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** The part of Pi's model registry that memory workers send requests through. */
export type WorkerModelRegistry = Pick<ModelRegistry, "streamSimple">;

/**
 * Stream function for one worker conversation. Requests go through Pi's own request path, which
 * selects the provider, including providers registered by extensions, and authenticates each
 * request when it is sent, so workers never hold credentials. The conversation gets its own
 * routing id, as Pi's summarization requests do; opencode, for one, rejects requests without it.
 */
export function workerStream(registry: WorkerModelRegistry): StreamFn {
	const sessionId = randomUUID();
	return (model, context, options) => registry.streamSimple(model, context, { ...options, sessionId });
}
