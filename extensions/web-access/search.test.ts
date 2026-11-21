import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { classifyError, configPath, loadRouting, search } from "./search.ts";
import type { ToolContext } from "./tools.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "web-access-search-"));

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	rmSync(configPath(), { force: true });
});

const noLogin = { getAll: () => [] } as unknown as ToolContext["modelRegistry"];
const codexLogin = {
	getAll: () => [{ provider: "openai-codex", id: "gpt-6-luna", baseUrl: "https://chatgpt.com/backend-api" }],
	getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "token" }),
} as unknown as ToolContext["modelRegistry"];

const exaBody = `data: ${JSON.stringify({ result: { content: [{ type: "text", text: "Title: E\nURL: https://e.example/\nText: exa text" }] } })}\n`;
const openaiBody = [
	{ type: "response.output_item.done", item: { type: "web_search_call", action: { sources: [{ url: "https://o.example/" }] } } },
	{ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "openai answer" }] } },
]
	.map((event) => `data: ${JSON.stringify(event)}\n`)
	.join("");

/** Routes fetches by host: `openai` and `exa` give the response for each provider. */
function mockProviders(responses: { openai?: () => Response; exa?: () => Response }) {
	const hosts: string[] = [];
	globalThis.fetch = async (input) => {
		const host = new URL(String(input)).hostname;
		hosts.push(host);
		const reply = host === "mcp.exa.ai" ? responses.exa : responses.openai;
		if (!reply) throw new Error(`unexpected fetch to ${host}`);
		return reply();
	};
	return hosts;
}

const options = { numResults: 5 };

test("loadRouting defaults to openai then exa and reads searchRouting, ignoring unknown entries", () => {
	assert.deepEqual(loadRouting(), { providers: ["openai", "exa"], fallbackOn: ["unsupported", "transient", "quota", "network", "invalid-response"] });
	writeFileSync(configPath(), JSON.stringify({ searchRouting: { providers: ["brave", "exa", "openai"], fallbackOn: ["quota", "off-topic", "empty"] } }));
	assert.deepEqual(loadRouting(), { providers: ["exa", "openai"], fallbackOn: ["quota", "empty"] });
	writeFileSync(configPath(), "{ broken");
	assert.throws(() => loadRouting(), /Failed to parse/);
});

test("classifyError sorts provider failures into routing kinds", () => {
	const cases: Array<[unknown, string]> = [
		[new Error("OpenAI API error 401: nope"), "auth"],
		[new Error("OpenAI API error 400: Tool web_search is not supported with this model"), "unsupported"],
		[new Error("OpenAI API error 400: bad"), "invalid-request"],
		[new Error("Exa MCP error 429: slow"), "quota"],
		[new Error("Exa MCP error 503: busy"), "transient"],
		[new Error("OpenAI API stream error (rate_limit_error/rate_limit_exceeded): x"), "quota"],
		[new Error("OpenAI API stream error (server_error): oops"), "transient"],
		[new Error("Exa's free MCP search hit its rate limit (quota)"), "quota"],
		[new Error("OpenAI web_search returned no web_search_call"), "invalid-response"],
		[new Error("Exa MCP returned no parseable results: x"), "invalid-response"],
		[new TypeError("fetch failed"), "network"],
		[Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), "network"],
		[new Error("something else"), "unknown"],
	];
	for (const [err, kind] of cases) assert.equal(classifyError(err), kind, String(err));
});

test("auto routing uses OpenAI when logged in and skips it when not", async () => {
	mockProviders({ openai: () => new Response(openaiBody), exa: () => new Response(exaBody) });
	const viaOpenAI = await search("q", options, "auto", codexLogin);
	assert.deepEqual([viaOpenAI.provider, viaOpenAI.answer], ["openai", "openai answer"]);
	const viaExa = await search("q", options, "auto", noLogin);
	assert.deepEqual([viaExa.provider, viaExa.results[0].url], ["exa", "https://e.example/"]);
});

test("auto routing falls through on listed error kinds only", async () => {
	const hosts = mockProviders({ openai: () => new Response("limit", { status: 429 }), exa: () => new Response(exaBody) });
	assert.equal((await search("q", options, "auto", codexLogin)).provider, "exa");
	assert.deepEqual(hosts, ["chatgpt.com", "mcp.exa.ai"]);

	writeFileSync(configPath(), JSON.stringify({ searchRouting: { providers: ["openai", "exa"], fallbackOn: ["transient"] } }));
	await assert.rejects(search("q", options, "auto", codexLogin), /^Error: openai \[quota\]: OpenAI API error 429: limit$/);
});

test("an empty response moves on only when fallbackOn lists empty, and the first empty answer is the last resort", async () => {
	const empty = `data: ${JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] } })}\n`;
	writeFileSync(configPath(), JSON.stringify({ searchRouting: { providers: ["exa", "openai"], fallbackOn: ["empty"] } }));
	mockProviders({ exa: () => new Response(empty), openai: () => new Response(openaiBody) });
	assert.equal((await search("q", options, "auto", codexLogin)).provider, "openai");
	assert.deepEqual(await search("q", options, "auto", noLogin), { answer: "", results: [], provider: "exa" });
});

test("an explicit provider is tried alone, and exhausted routing lists every failure", async () => {
	const hosts = mockProviders({ exa: () => new Response(exaBody) });
	assert.equal((await search("q", options, "exa", codexLogin)).provider, "exa");
	assert.deepEqual(hosts, ["mcp.exa.ai"]);
	await assert.rejects(search("q", options, "openai", noLogin), /No search provider succeeded:\n {2}- openai: unavailable/);

	mockProviders({ exa: () => new Response("down", { status: 502 }) });
	await assert.rejects(search("q", options, "auto", noLogin), /No search provider succeeded:\n {2}- openai: unavailable.*\n {2}- exa \[transient\]: Exa MCP error 502: down/);
});

test("an abort is rethrown, not routed", async () => {
	const controller = new AbortController();
	globalThis.fetch = async () => {
		controller.abort();
		throw Object.assign(new Error("aborted"), { name: "AbortError" });
	};
	await assert.rejects(search("q", { numResults: 5, signal: controller.signal }, "auto", noLogin), /aborted/);
});
