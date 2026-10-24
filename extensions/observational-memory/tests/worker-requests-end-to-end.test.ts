import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { streamSimple as builtInStreamSimple } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import observationalMemory from "../src/index.ts";
import { OM_OBSERVATIONS_RECORDED, OM_REFLECTIONS_RECORDED } from "../src/session-ledger/index.ts";

/**
 * A real Pi session with the extension loaded: Pi's ModelRuntime, credential store, provider
 * registrations and extension context, and a local OpenAI-compatible server standing in for the
 * providers. Memory workers must reach every model the way Pi's own requests do.
 */

type SeenRequest = {
	path: string;
	tool?: string;
	authorization?: string;
	customStream?: string;
	opencodeSession?: string;
	opencodeClient?: string;
};

const OBSERVATION = "User keeps the deploy key in vault.";
const REFLECTION = "The deploy key is stored in vault.";

let tempDir: string;
let server: Server | undefined;
let previousAgentDir: string | undefined;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "om-worker-requests-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
	mkdirSync(join(tempDir, "agent"), { recursive: true });
	mkdirSync(join(tempDir, "project"), { recursive: true });
});

afterEach(async () => {
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
	server = undefined;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempDir, { recursive: true, force: true });
});

function sse(chunks: unknown[]): string {
	return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function completionChunk(delta: unknown, finishReason: string | null) {
	return { id: "chatcmpl-om", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function toolCallResponse(name: string, args: unknown): string {
	return sse([
		completionChunk({ role: "assistant", tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null),
		completionChunk({}, "tool_calls"),
	]);
}

function textResponse(text: string): string {
	return sse([completionChunk({ role: "assistant", content: text }, null), completionChunk({}, "stop")]);
}

function requestText(body: any): string {
	return JSON.stringify(body?.messages ?? []);
}

/** Answer memory workers with their tool call and the session with text. */
function workerResponse(body: any): string {
	const tool: string | undefined = body?.tools?.[0]?.function?.name;
	if (tool === "record_observations") {
		const sourceEntryId = /Source entry id: ([0-9a-f]{8})\]/.exec(requestText(body))?.[1];
		return toolCallResponse(tool, {
			observations: [{ timestamp: "2026-10-24 10:00", content: OBSERVATION, relevance: "high", sourceEntryIds: [sourceEntryId] }],
		});
	}
	if (tool === "record_reflections") {
		const observationId = /\[([a-f0-9]{6,})\] \d{4}-\d{2}-\d{2}/.exec(requestText(body))?.[1];
		return toolCallResponse(tool, { reflections: [{ content: REFLECTION, supportingObservationIds: [observationId] }] });
	}
	return textResponse("Noted.");
}

type Handler = (request: SeenRequest, body: any) => Promise<{ status: number; body: string }> | { status: number; body: string };

async function startProviderServer(handler: Handler, seen: SeenRequest[]): Promise<string> {
	server = createServer((req: IncomingMessage, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", async () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			const request: SeenRequest = {
				path: req.url ?? "",
				tool: body?.tools?.[0]?.function?.name,
				authorization: req.headers.authorization,
				customStream: req.headers["x-custom-stream"] as string | undefined,
				opencodeSession: req.headers["x-opencode-session"] as string | undefined,
				opencodeClient: req.headers["x-opencode-client"] as string | undefined,
			};
			seen.push(request);
			const reply = await handler(request, body);
			res.writeHead(reply.status, { "content-type": reply.status === 200 ? "text/event-stream" : "application/json" });
			res.end(reply.body);
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

function chatModel(id: string, baseUrl: string) {
	return {
		id,
		name: id,
		api: "openai-completions" as const,
		baseUrl,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
	};
}

function writeMemorySettings(memory: Record<string, unknown>): void {
	writeFileSync(join(tempDir, "agent", "settings.json"), JSON.stringify({
		"observational-memory": {
			observeAfterTokens: 1,
			reflectAfterTokens: 1_000_000,
			agentMaxTurns: 1,
			showWorkerNotifications: false,
			...memory,
		},
	}));
}

async function startSession(registry: ModelRegistry, runtime: ModelRuntime, baseUrl: string) {
	registry.registerProvider("session-llm", { baseUrl: `${baseUrl}/session`, apiKey: "session-key", api: "openai-completions", models: [chatModel("chat", `${baseUrl}/session`)] });
	const cwd = join(tempDir, "project");
	const agentDir = join(tempDir, "agent");
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [observationalMemory] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: registry.find("session-llm", "chat"),
		thinkingLevel: "off",
		modelRuntime: runtime,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader,
		noTools: true,
	});
	return session;
}

function memoryEntries(session: { sessionManager: { getBranch(): unknown[] } }, customType: string): any[] {
	return session.sessionManager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === customType);
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function createRuntime() {
	const credentials = new InMemoryCredentialStore();
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	return { credentials, runtime, registry: new ModelRegistry(runtime) };
}

describe("memory worker requests in a real Pi session", { timeout: 20_000 }, () => {
	it("sends each worker request with the credential Pi holds when the request is sent", async () => {
		const { credentials, runtime, registry } = await createRuntime();
		await credentials.modify("memory-llm", async () => ({ type: "api_key", key: "key-1" }));
		let acceptedKey = "key-1";
		const seen: SeenRequest[] = [];
		const baseUrl = await startProviderServer(async (request, body) => {
			if (!request.path.startsWith("/memory")) return { status: 200, body: workerResponse(body) };
			if (request.authorization !== `Bearer ${acceptedKey}`) {
				return { status: 401, body: JSON.stringify({ error: { message: "credential revoked" } }) };
			}
			if (request.tool === "record_observations") {
				// The credential rotates while the memory pass runs: the old one is revoked.
				await credentials.modify("memory-llm", async () => ({ type: "api_key", key: "key-2" }));
				acceptedKey = "key-2";
			}
			return { status: 200, body: workerResponse(body) };
		}, seen);
		registry.registerProvider("memory-llm", { baseUrl: `${baseUrl}/memory`, api: "openai-completions", models: [chatModel("worker", `${baseUrl}/memory`)] });
		writeMemorySettings({ reflectAfterTokens: 1, model: { provider: "memory-llm", id: "worker", thinking: "off" } });

		const session = await startSession(registry, runtime, baseUrl);
		try {
			await session.prompt("Remember: the deploy key lives in vault.");
			await waitFor(() => memoryEntries(session, OM_REFLECTIONS_RECORDED).length > 0);

			const memoryRequests = seen.filter((request) => request.path.startsWith("/memory"));
			expect(memoryRequests.map((request) => [request.tool, request.authorization])).toEqual([
				["record_observations", "Bearer key-1"],
				["record_reflections", "Bearer key-2"],
			]);
			expect(memoryEntries(session, OM_OBSERVATIONS_RECORDED)[0].data.observations[0].content).toBe(OBSERVATION);
			expect(memoryEntries(session, OM_REFLECTIONS_RECORDED)[0].data.reflections[0].content).toBe(REFLECTION);
		} finally {
			session.dispose();
		}
	});

	it("reaches a provider an extension registers with its own stream and OAuth login", async () => {
		const { credentials, runtime, registry } = await createRuntime();
		await credentials.modify("sub-llm", async () => ({ type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 3_600_000 }));
		const seen: SeenRequest[] = [];
		const baseUrl = await startProviderServer((_request, body) => ({ status: 200, body: workerResponse(body) }), seen);
		registry.registerProvider("sub-llm", {
			baseUrl: `${baseUrl}/sub`,
			api: "sub-llm-api" as any,
			oauth: {
				name: "Sub LLM",
				login: async () => { throw new Error("login is not part of this test"); },
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
			streamSimple: (model, context, options) => builtInStreamSimple(
				{ ...model, api: "openai-completions" } as any,
				context,
				{ ...options, headers: { ...options?.headers, "x-custom-stream": "sub-llm" } },
			),
			models: [{ ...chatModel("worker", `${baseUrl}/sub`), api: "sub-llm-api" as any }],
		});
		writeMemorySettings({ model: { provider: "sub-llm", id: "worker", thinking: "off" } });

		const session = await startSession(registry, runtime, baseUrl);
		try {
			await session.prompt("Remember: the deploy key lives in vault.");
			await waitFor(() => memoryEntries(session, OM_OBSERVATIONS_RECORDED).length > 0);

			const memoryRequests = seen.filter((request) => request.path.startsWith("/sub"));
			expect(memoryRequests.map((request) => [request.tool, request.authorization, request.customStream])).toEqual([
				["record_observations", "Bearer oauth-access", "sub-llm"],
			]);
			expect(memoryEntries(session, OM_OBSERVATIONS_RECORDED)[0].data.observations[0].content).toBe(OBSERVATION);
		} finally {
			session.dispose();
		}
	});

	it("retries with the fallback model when Pi cannot authenticate the primary", async () => {
		const { credentials, runtime, registry } = await createRuntime();
		await credentials.modify("backup-llm", async () => ({ type: "api_key", key: "backup-key" }));
		const seen: SeenRequest[] = [];
		const baseUrl = await startProviderServer((_request, body) => ({ status: 200, body: workerResponse(body) }), seen);
		registry.registerProvider("logged-out-llm", { baseUrl: `${baseUrl}/logged-out`, api: "openai-completions", models: [chatModel("worker", `${baseUrl}/logged-out`)] });
		registry.registerProvider("backup-llm", { baseUrl: `${baseUrl}/backup`, api: "openai-completions", models: [chatModel("worker", `${baseUrl}/backup`)] });
		writeMemorySettings({
			model: { provider: "logged-out-llm", id: "worker", thinking: "off" },
			fallbackModel: { provider: "backup-llm", id: "worker", thinking: "off" },
		});

		const session = await startSession(registry, runtime, baseUrl);
		try {
			await session.prompt("Remember: the deploy key lives in vault.");
			await waitFor(() => memoryEntries(session, OM_OBSERVATIONS_RECORDED).length > 0);

			expect(seen.filter((request) => request.path.startsWith("/logged-out"))).toEqual([]);
			expect(seen.filter((request) => request.path.startsWith("/backup")).map((request) => [request.tool, request.authorization])).toEqual([
				["record_observations", "Bearer backup-key"],
			]);
			expect(memoryEntries(session, OM_OBSERVATIONS_RECORDED)[0].data.observations[0].content).toBe(OBSERVATION);
		} finally {
			session.dispose();
		}
	});

	it("gives each worker conversation the routing OpenCode requires, as Pi's own requests get", async () => {
		const { credentials, runtime, registry } = await createRuntime();
		await credentials.modify("opencode-go", async () => ({ type: "api_key", key: "go-key" }));
		const seen: SeenRequest[] = [];
		const baseUrl = await startProviderServer((_request, body) => ({ status: 200, body: workerResponse(body) }), seen);
		registry.registerProvider("opencode-go", { baseUrl: `${baseUrl}/opencode`, api: "openai-completions", models: [chatModel("worker", `${baseUrl}/opencode`)] });
		writeMemorySettings({ reflectAfterTokens: 1, model: { provider: "opencode-go", id: "worker", thinking: "off" } });

		const session = await startSession(registry, runtime, baseUrl);
		try {
			await session.prompt("Remember: the deploy key lives in vault.");
			await waitFor(() => memoryEntries(session, OM_REFLECTIONS_RECORDED).length > 0);

			const memoryRequests = seen.filter((request) => request.path.startsWith("/opencode"));
			expect(memoryRequests.map((request) => [request.tool, request.authorization, request.opencodeClient])).toEqual([
				["record_observations", "Bearer go-key", "pi"],
				["record_reflections", "Bearer go-key", "pi"],
			]);
			const [observer, reflector] = memoryRequests.map((request) => request.opencodeSession);
			expect(observer).toMatch(/^[0-9a-f-]{36}$/);
			expect(reflector).toMatch(/^[0-9a-f-]{36}$/);
			expect(reflector).not.toBe(observer);
			expect(observer).not.toBe(session.sessionId);
		} finally {
			session.dispose();
		}
	});
});
