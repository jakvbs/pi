import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildRequest, parseOutput, pickSearchModel, resolveOpenAIAuth, searchOpenAI, toSearchResponse } from "./openai-search.ts";
import type { ToolContext } from "./tools.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

function registry(models: Array<{ provider: string; id: string; baseUrl: string }>, auth: Record<string, { apiKey?: string; baseUrl?: string; headers?: Record<string, string | null> }>) {
	return {
		getAll: () => models,
		getApiKeyAndHeaders: async (model: { provider: string }) => (auth[model.provider] ? { ok: true, ...auth[model.provider] } : { ok: false, error: "no key" }),
	} as unknown as ToolContext["modelRegistry"];
}

function sse(events: object[]): string {
	return events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const searchCall = { type: "web_search_call", action: { sources: [{ url: "https://src.example/b", title: "B" }, { url: "https://cited.example/a?utm_source=openai" }] } };
const message = {
	type: "message",
	content: [
		{
			type: "output_text",
			text: "The answer is 42 [cited](https://cited.example/a?utm_source=openai).",
			annotations: [{ type: "url_citation", url: "https://cited.example/a?utm_source=openai", title: "Cited A", start_index: 14, end_index: 70 }],
		},
	],
};

test("pickSearchModel prefers the newest luna model and skips price tiers", () => {
	const pick = (ids: string[]) => pickSearchModel(ids.map((id) => ({ id })))?.id;
	assert.equal(pick(["gpt-5.6-luna", "gpt-6-luna", "gpt-6-sol", "gpt-6-luna-pro"]), "gpt-6-luna");
	assert.equal(pick(["gpt-5.9", "gpt-5.10", "gpt-5.10-pro"]), "gpt-5.10");
	assert.equal(pick(["gpt-6-sol", "gpt-5-astra"]), "gpt-6-sol");
	assert.equal(pick([]), undefined);
});

test("Codex login searches through the Codex backend with the account id; an openai key only on the official API", async () => {
	const codex = await resolveOpenAIAuth(
		registry([{ provider: "openai-codex", id: "gpt-6-luna", baseUrl: "https://chatgpt.com/backend-api" }], {
			"openai-codex": { apiKey: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }), headers: { "x-extra": "1", dropped: null } },
		}),
	);
	assert.equal(codex?.url, "https://chatgpt.com/backend-api/codex/responses");
	assert.equal(codex?.model, "gpt-6-luna");
	assert.equal(codex?.headers["chatgpt-account-id"], "acct-1");
	assert.equal(codex?.headers.originator, "pi");
	assert.equal(codex?.headers["x-extra"], "1");
	assert.equal("dropped" in (codex?.headers ?? {}), false);

	const official = await resolveOpenAIAuth(registry([{ provider: "openai", id: "gpt-6", baseUrl: "https://api.openai.com/v1" }], { openai: { apiKey: "sk-1" } }));
	assert.deepEqual([official?.url, official?.headers.Authorization], ["https://api.openai.com/v1/responses", "Bearer sk-1"]);

	const gateway = registry([{ provider: "openai", id: "gpt-6", baseUrl: "https://gateway.example/v1" }], { openai: { apiKey: "sk-1" } });
	assert.equal(await resolveOpenAIAuth(gateway), undefined);
	assert.equal(await resolveOpenAIAuth(registry([{ provider: "openai-codex", id: "gpt-6", baseUrl: "" }], {})), undefined);
});

test("the request requires the web_search tool and carries domain and recency hints", () => {
	const body = buildRequest("q", { numResults: 3, domainFilter: ["https://docs.example/x", "-spam.example"], recencyFilter: "week" }, "gpt-6-luna");
	assert.deepEqual(body.tools, [{ type: "web_search", filters: { allowed_domains: ["docs.example"], blocked_domains: ["spam.example"] } }]);
	assert.equal(body.tool_choice, "required");
	assert.equal(body.stream, true);
	assert.match(String(body.instructions), /past week.*around 3 distinct sources.*Only use sources from: docs\.example\..*Do not use sources from: spam\.example\./);
	assert.deepEqual(buildRequest("q", { numResults: 5 }, "m").tools, [{ type: "web_search" }]);
});

test("parseOutput reads streamed output items or the completed response, and throws on stream errors", () => {
	assert.deepEqual(parseOutput(sse([{ type: "response.output_item.done", item: searchCall }, { type: "response.output_item.done", item: message }])), [searchCall, message]);
	assert.deepEqual(parseOutput(sse([{ type: "response.completed", response: { output: [message] } }])), [message]);
	assert.deepEqual(parseOutput(JSON.stringify({ output: [message] })), [message]);
	assert.throws(() => parseOutput(sse([{ type: "error", error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Slow down" } }])), /OpenAI API stream error \(rate_limit_error\/rate_limit_exceeded\): Slow down/);
	assert.throws(() => parseOutput(sse([{ type: "response.failed", response: { error: null } }])), /invalid response/);
	assert.throws(() => parseOutput("data: [DONE]\n"), /no parseable response output/);
});

test("toSearchResponse lists cited sources first with their context, then the other sources", () => {
	const response = toSearchResponse([searchCall, message], 5);
	assert.equal(response.answer, "The answer is 42 [cited](https://cited.example/a?utm_source=openai).");
	assert.deepEqual(response.results, [
		{ url: "https://cited.example/a", title: "Cited A", snippet: "The answer is 42 cited." },
		{ url: "https://src.example/b", title: "B", snippet: "" },
	]);
	assert.equal(toSearchResponse([searchCall, message], 1).results.length, 1);
	assert.throws(() => toSearchResponse([message], 5), /no web_search_call/);
	assert.throws(() => toSearchResponse([{ type: "web_search_call" }], 5), /no answer or sources/);
});

test("searchOpenAI posts the request and redacts the key from API errors", async () => {
	const auth = { provider: "openai" as const, model: "gpt-6", apiKey: "sk-secret", headers: { Authorization: "Bearer sk-secret" }, url: "https://api.openai.com/v1/responses" };
	let sent: { url: string; body: Record<string, unknown> } | undefined;
	globalThis.fetch = async (input, init) => {
		sent = { url: String(input), body: JSON.parse(String(init?.body)) };
		return new Response(sse([{ type: "response.output_item.done", item: searchCall }, { type: "response.output_item.done", item: message }]));
	};
	const response = await searchOpenAI("what is it", { numResults: 5 }, auth);
	assert.equal(sent?.url, auth.url);
	assert.equal(sent?.body.model, "gpt-6");
	assert.equal(response.results.length, 2);

	globalThis.fetch = async () => new Response("bad key sk-secret", { status: 401 });
	await assert.rejects(searchOpenAI("q", { numResults: 5 }, auth), (err: Error) => err.message === "OpenAI API error 401: bad key [redacted]");
});
