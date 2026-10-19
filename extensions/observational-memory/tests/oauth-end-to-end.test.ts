import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { DEFAULTS } from "../src/config.ts";
import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.ts";
import { Runtime } from "../src/runtime.ts";
import { OM_OBSERVATIONS_RECORDED } from "../src/session-ledger/index.ts";
import { textCustomMessage } from "./fixtures/session.ts";

/**
 * End-to-end coverage for OAuth-authenticated providers: a headers-only auth
 * resolution (no apiKey) must flow from pi's real ModelRegistry through
 * resolveModel into a real observer model request that authenticates with the
 * caller-supplied Authorization header, and the resulting observations must land
 * in the session ledger.
 */

const OAUTH_ACCESS_TOKEN = "pi-oauth-access-token";
const OAUTH_TOKEN = `Bearer ${OAUTH_ACCESS_TOKEN}`;

type RecordedRequest = { headers: Record<string, string | undefined>; body: any };

function chunk(delta: unknown, finishReason: string | null, usage?: unknown): string {
	const body = { id: "chatcmpl_e2e", object: "chat.completion.chunk", created: 0, model: "om-e2e", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
	return `data: ${JSON.stringify(body)}\n\n`;
}

function toolCallStream(toolInput: unknown): string {
	return [
		chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_e2e", type: "function", function: { name: "record_observations", arguments: JSON.stringify(toolInput) } }] }, null),
		chunk({}, "tool_calls", { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 }),
		"data: [DONE]\n\n",
	].join("");
}

async function startMockChatCompletions(requests: RecordedRequest[]): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			requests.push({ headers: req.headers as Record<string, string | undefined>, body: raw ? JSON.parse(raw) : undefined });
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.end(toolCallStream({
				observations: [{
					timestamp: "2026-05-02 10:30",
					content: "User authenticated with an OAuth provider and asked for memory consolidation.",
					relevance: "high",
					sourceEntryIds: ["raw-1"],
				}],
			}));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * pi's real ModelRegistry over a minimal ModelRuntime whose provider auth is
 * OAuth-shaped: no stored apiKey, an Authorization header instead. This is the
 * `{ ok: true, headers }` (no apiKey) result the real registry hands extensions.
 */
async function oauthModelRegistry(): Promise<ModelRegistry> {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("kimi-coding", async () => ({
		type: "oauth",
		access: OAUTH_ACCESS_TOKEN,
		refresh: "unused-refresh-token",
		expires: Date.now() + 60 * 60 * 1000,
	}));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	return new ModelRegistry(runtime);
}

/** Minimal registry state for an OAuth provider whose credentials no longer resolve. */
function expiredOAuthModelRegistry(): any {
	return {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: undefined, headers: undefined }),
		isUsingOAuth: () => true,
	};
}

let activeServer: Server | undefined;

afterEach(async () => {
	if (activeServer) await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
	activeServer = undefined;
});

describe("OAuth provider end-to-end consolidation", () => {
	it("records observations using headers-only OAuth auth on a real model request", async () => {
		const requests: RecordedRequest[] = [];
		const { server, baseUrl } = await startMockChatCompletions(requests);
		activeServer = server;

		const model = {
			id: "om-e2e",
			name: "OAuth E2E",
			api: "openai-completions",
			provider: "kimi-coding",
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_000,
		};

		const entries = [textCustomMessage("raw-1", "User: please remember that the OAuth login works.")];
		const appended: Array<{ customType: string; data: any }> = [];
		const notices: string[] = [];
		const handlers: Record<string, ((event: unknown, ctx: any) => void) | undefined> = {};
		const pi = {
			on: vi.fn((eventName: string, cb: (event: unknown, ctx: any) => void) => { handlers[eventName] = cb; }),
			appendEntry: vi.fn((customType: string, data: unknown) => {
				appended.push({ customType, data });
				return `appended-${appended.length}`;
			}),
		};

		const runtime = new Runtime();
		runtime.configLoaded = true;
		runtime.config = { ...DEFAULTS, observeAfterTokens: 1, reflectAfterTokens: 1_000_000, agentMaxTurns: 1 };

		registerConsolidationTrigger(pi as any, runtime);

		handlers.turn_end!(undefined, {
			cwd: process.cwd(),
			hasUI: true,
			ui: { notify: (message: string) => notices.push(message) },
			model,
			modelRegistry: await oauthModelRegistry(),
			sessionManager: { getBranch: () => entries },
		});
		await runtime.consolidationPromise;

		// The observer really called the provider, authenticating with the OAuth header.
		expect(requests).toHaveLength(1);
		expect(requests[0].headers.authorization).toBe(OAUTH_TOKEN);
		expect(requests[0].headers["x-api-key"]).toBeUndefined();

		// The observation reached the session ledger; nothing was skipped.
		const recorded = appended.filter((entry) => entry.customType === OM_OBSERVATIONS_RECORDED);
		expect(recorded).toHaveLength(1);
		expect(recorded[0].data.observations[0].content).toContain("OAuth provider");
		expect(recorded[0].data.coversUpToId).toBe("raw-1");
		expect(notices.filter((message) => message.includes("skipped"))).toEqual([]);

		// eslint-disable-next-line no-console
		console.log([
			"",
			"── OAuth consolidation transcript ─────────────────────────────",
			`resolved auth        : apiKey=<none> headers.Authorization=${OAUTH_TOKEN}`,
			`provider request     : POST ${baseUrl}/chat/completions`,
			`request authorization: ${requests[0].headers.authorization}`,
			`request x-api-key    : ${requests[0].headers["x-api-key"] ?? "<none>"}`,
			`ledger entry         : ${recorded[0].customType} coversUpToId=${recorded[0].data.coversUpToId}`,
			`observation          : ${recorded[0].data.observations[0].content}`,
			`user notices         : ${notices.join(" | ")}`,
			"───────────────────────────────────────────────────────────────",
		].join("\n"));
	});

	it("tells the user to re-login when OAuth credentials no longer resolve", async () => {
		const model = { id: "gpt-5-codex", name: "Codex", api: "openai-responses", provider: "openai-codex", contextWindow: 200_000, maxTokens: 8_000 };
		const entries = [textCustomMessage("raw-1", "User: please remember that the OAuth login works.")];
		const notices: string[] = [];
		const appended: unknown[] = [];
		const handlers: Record<string, ((event: unknown, ctx: any) => void) | undefined> = {};
		const pi = {
			on: vi.fn((eventName: string, cb: (event: unknown, ctx: any) => void) => { handlers[eventName] = cb; }),
			appendEntry: vi.fn((customType: string, data: unknown) => { appended.push({ customType, data }); return "appended-1"; }),
		};

		const runtime = new Runtime();
		runtime.configLoaded = true;
		runtime.config = { ...DEFAULTS, observeAfterTokens: 1, reflectAfterTokens: 1_000_000, agentMaxTurns: 1 };

		registerConsolidationTrigger(pi as any, runtime);
		handlers.turn_end!(undefined, {
			cwd: process.cwd(),
			hasUI: true,
			ui: { notify: (message: string) => notices.push(message) },
			model,
			modelRegistry: expiredOAuthModelRegistry(),
			sessionManager: { getBranch: () => entries },
		});
		await runtime.consolidationPromise;

		const skipped = notices.find((message) => message.includes("skipped"));
		expect(skipped).toBe(
			'Observational memory: observer skipped — authentication failed for provider "openai-codex" — OAuth credentials may have expired; run \'/login openai-codex\' to re-authenticate',
		);
		expect(appended).toEqual([]);

		// eslint-disable-next-line no-console
		console.log([
			"",
			"── Expired-OAuth user notice ──────────────────────────────────",
			skipped,
			"───────────────────────────────────────────────────────────────",
		].join("\n"));
	});
});
