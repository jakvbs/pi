// Client for pi-subagents' in-process event-bus RPC (extensions/subagents/docs/extension-api.md).
import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Emitted by pi-subagents when a background run's result reached its parent session. */
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export type SubagentsMethod = "spawn" | "steer" | "stop" | "resume" | "status";

/** The `details` pi-subagents returns for a background launch or a resume. */
export interface LaunchDetails {
	asyncId: string;
	asyncDir: string;
}

interface RpcReply {
	success: boolean;
	data?: { text?: string; details?: Partial<LaunchDetails> };
	error?: { code: string; message: string };
}

/** Sends one RPC request and resolves with its `data`; rejects with the reply's error or after `timeoutMs`. */
export function callSubagents(
	events: EventBus,
	method: SubagentsMethod,
	params: Record<string, unknown>,
	timeoutMs = 120_000,
): Promise<NonNullable<RpcReply["data"]>> {
	const requestId = randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(`pi-subagents did not answer ${method} within ${timeoutMs} ms; is the subagents extension loaded?`));
		}, timeoutMs);
		const unsubscribe = events.on(`subagents:rpc:v1:reply:${requestId}`, (raw) => {
			clearTimeout(timer);
			unsubscribe();
			const reply = raw as RpcReply;
			if (reply.success) resolve(reply.data ?? {});
			else reject(new Error(`pi-subagents ${method} failed (${reply.error?.code}): ${reply.error?.message}`));
		});
		events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params });
	});
}

/** Reads the run id and directory out of a launch or resume reply. */
export function launchDetails(data: Awaited<ReturnType<typeof callSubagents>>): LaunchDetails {
	const { asyncId, asyncDir } = data.details ?? {};
	if (!asyncId || !asyncDir) throw new Error(`pi-subagents reply has no async run: ${data.text ?? "(no text)"}`);
	return { asyncId, asyncDir };
}
