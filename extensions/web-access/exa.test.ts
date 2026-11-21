import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseMcpReply, parseResults, searchExa } from "./exa.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const sseReply = (result: object) => `event: message\ndata: ${JSON.stringify({ result, jsonrpc: "2.0", id: 1 })}\n`;
const textReply = (text: string) => sseReply({ content: [{ type: "text", text }] });
const basicText = "Title: First\nURL: https://a.example/1\nPublished: 2026-01-01\nText: Body of the first result.\n---\n\nTitle: Second\nURL: https://b.example/2\nHighlights:\nKey line of the second.";

function mockExa(reply: (tool: string, args: Record<string, unknown>) => Response) {
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	globalThis.fetch = async (input, init) => {
		const tool = new URL(String(input)).searchParams.get("tools") ?? "";
		const args = JSON.parse(String(init?.body)).params.arguments;
		calls.push({ tool, args });
		return reply(tool, args);
	};
	return calls;
}

test("parseMcpReply reads SSE and JSON replies and reports rate limits and tool errors", () => {
	assert.equal(parseMcpReply(textReply("hello")), "hello");
	assert.equal(parseMcpReply(JSON.stringify({ result: { content: [{ type: "text", text: "plain" }] } })), "plain");
	assert.throws(() => parseMcpReply(sseReply({ _meta: { "ai.exa/rateLimited": true }, content: [{ type: "text", text: "limit" }] })), /rate limit \(quota\)/);
	assert.throws(() => parseMcpReply(JSON.stringify({ error: { code: -32000, message: "boom" } })), /Exa MCP error: boom/);
	assert.throws(() => parseMcpReply(sseReply({ isError: true, content: [{ type: "text", text: "bad args" }] })), /bad args/);
	assert.throws(() => parseMcpReply(sseReply({ content: [] })), /empty content/);
	assert.throws(() => parseMcpReply(""), /empty response/);
});

test("parseResults reads the basic tool's text blocks and the advanced tool's JSON", () => {
	assert.deepEqual(parseResults(basicText), [
		{ url: "https://a.example/1", title: "First", snippet: "Body of the first result." },
		{ url: "https://b.example/2", title: "Second", snippet: "Key line of the second." },
	]);
	assert.deepEqual(parseResults(JSON.stringify({ results: [{ url: "https://c.example/", highlights: ["h1", "h2"] }, { title: "no url" }] })), [
		{ url: "https://c.example/", title: "c.example", snippet: "h1 h2" },
	]);
	assert.throws(() => parseResults("Something unexpected"), /no parseable results: Something unexpected/);
});

test("an unfiltered search calls the basic tool with the query and result count", async () => {
	const calls = mockExa(() => new Response(textReply(basicText)));
	const response = await searchExa("pi agent", { numResults: 4 });
	assert.deepEqual(calls, [{ tool: "web_search_exa", args: { query: "pi agent", numResults: 4 } }]);
	assert.equal(response.answer, "");
	assert.equal(response.results.length, 2);
});

test("a filtered search uses the advanced tool and falls back to the basic tool with the filters in the query", async () => {
	const calls = mockExa((tool) => new Response(tool === "web_search_advanced_exa" ? textReply(JSON.stringify({ results: [{ url: "https://reddit.com/r", title: "R" }] })) : textReply(basicText)));
	const response = await searchExa("q", { numResults: 3, domainFilter: ["reddit.com", "-spam.example"], recencyFilter: "day" });
	assert.equal(calls[0].tool, "web_search_advanced_exa");
	assert.deepEqual(calls[0].args.includeDomains, ["reddit.com"]);
	assert.deepEqual(calls[0].args.excludeDomains, ["spam.example"]);
	assert.ok(Date.now() - Date.parse(String(calls[0].args.startPublishedDate)) < 86_400_000 + 60_000);
	assert.deepEqual(response.results, [{ url: "https://reddit.com/r", title: "R", snippet: "" }]);

	const fallback = mockExa((tool) => (tool === "web_search_advanced_exa" ? new Response("no such tool", { status: 400 }) : new Response(textReply(basicText))));
	await searchExa("q", { numResults: 3, domainFilter: ["reddit.com"], recencyFilter: "week" });
	assert.deepEqual(fallback.map((call) => call.tool), ["web_search_advanced_exa", "web_search_exa"]);
	assert.equal(fallback[1].args.query, "q site:reddit.com past 7 days");
});

test("HTTP errors carry the status for routing", async () => {
	mockExa(() => new Response("busy", { status: 503 }));
	await assert.rejects(searchExa("q", { numResults: 5 }), /Exa MCP error 503: busy/);
});
