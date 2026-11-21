import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { SessionEntryData } from "./storage.ts";
import { MAX_OUTPUT_CHARS, parseStringArrays, runFetchContent, runGetSearchContent, runWebSearch, type ToolContext, type ToolResult } from "./tools.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "web-access-tools-"));
process.env.TMPDIR = mkdtempSync(join(tmpdir(), "web-access-tools-tmp-"));

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
/** No OpenAI login, so searches go to Exa; answers come from a fake current model. */
const ctx = {
	model: { provider: "p", id: "m", contextWindow: 100_000, reasoning: false },
	sessionManager: { getSessionId: () => "s" },
	modelRegistry: {
		getAll: () => [],
		streamSimple: (_model: unknown, context: { messages: Array<{ content: Array<{ text: string }> }> }) => ({
			result: async () => ({ stopReason: "stop", content: [{ type: "text", text: `answer to: ${context.messages[0].content[0].text.split("\n")[0]}` }], usage }),
		}),
	},
} as unknown as ToolContext;

function collect() {
	const published: SessionEntryData[] = [];
	return { published, publish: (data: SessionEntryData) => published.push(data) };
}

const textOf = (result: ToolResult) => (result.content[0].type === "text" ? result.content[0].text : "");
const exaReply = (text: string) => `data: ${JSON.stringify({ result: { content: [{ type: "text", text }] } })}\n`;

/** Serves pages by URL path; `/missing` is a 404. */
function servePages(pages: Record<string, string>) {
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		if (url.hostname === "mcp.exa.ai") throw new Error("no search expected");
		const body = pages[url.pathname];
		return body === undefined ? new Response("", { status: 404, statusText: "Not Found" }) : new Response(body, { headers: { "content-type": "text/plain" } });
	};
}

test("parseStringArrays turns JSON-array strings into arrays and rejects broken JSON", () => {
	assert.deepEqual(parseStringArrays({ queries: '["a","b"]', numResults: 3 }, ["queries"]), { queries: ["a", "b"], numResults: 3 });
	assert.deepEqual(parseStringArrays({ queries: "plain" }, ["queries"]), { queries: "plain" });
	assert.throws(() => parseStringArrays({ urls: "[nope" }, ["urls"]), /urls must be an array of strings/);
});

test("web_search runs every query, stores the results and points at them", async () => {
	const queries: string[] = [];
	globalThis.fetch = async (_input, init) => {
		const query = JSON.parse(String(init?.body)).params.arguments.query;
		queries.push(query);
		if (query === "bad") return new Response("down", { status: 500 });
		return new Response(exaReply(`Title: Result for ${query}\nURL: https://r.example/${query}\nText: Snippet ${query}`));
	};
	const { published, publish } = collect();
	const result = await runWebSearch({ queries: ["one", " ", "bad"], numResults: 3 }, ctx, publish);
	assert.deepEqual(queries.sort(), ["bad", "one"]);
	assert.equal(result.isError, undefined);
	const output = textOf(result);
	assert.match(output, /^\*\*Providers used:\*\* Query 1: exa; Query 2: none\n\n## Query: "one"\n\n1\. Result for one\n {3}https:\/\/r\.example\/one\n {3}Snippet one\n\n## Query: "bad"\n\nError: No search provider succeeded:/);
	assert.equal(published.length, 1);
	const id = published[0].id;
	assert.match(output, new RegExp(`Full search results are stored as responseId "${id}"\\. Use get_search_content\\(\\{ responseId: "${id}", queryIndex: 0 \\}\\) to read them; repeat with queryIndex 1 through 1\\.$`));
	assert.deepEqual([result.details.queryCount, result.details.successfulQueries, result.details.totalResults, result.details.searchId], [2, 1, 1, id]);
});

test("web_search splits a JSON-array query, reports a missing query, and fails when every query fails", async () => {
	globalThis.fetch = async () => new Response("down", { status: 500 });
	const { publish } = collect();
	const failed = await runWebSearch({ query: '["x", "y"]' }, ctx, publish);
	assert.equal(failed.isError, true);
	assert.deepEqual(failed.details.queries, ["x", "y"]);
	const none = await runWebSearch({ queries: [] }, ctx, publish);
	assert.equal(textOf(none), "Error: No query provided. Use 'query' or 'queries' parameter.");
});

test("provider all asks every provider and keeps what succeeded", async () => {
	globalThis.fetch = async () => new Response(exaReply("Title: E\nURL: https://e.example/\nText: exa"));
	const { publish } = collect();
	const result = await runWebSearch({ query: "q", provider: "all" }, ctx, publish);
	assert.match(textOf(result), /^\*\*Provider:\*\* exa\n\n1\. E\n {3}https:\/\/e\.example\//);
	globalThis.fetch = async () => new Response("down", { status: 500 });
	const failed = await runWebSearch({ query: "q", provider: "all" }, ctx, publish);
	assert.equal(failed.isError, true);
	assert.match(textOf(failed), /openai: unavailable[\s\S]*Exa MCP error 500/);
});

test("web_search includeContent fetches and stores every result page under a fetchId", async () => {
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		if (url.hostname === "mcp.exa.ai") return new Response(exaReply("Title: P\nURL: http://93.184.215.14/p\nText: s\n\nTitle: Q\nURL: http://93.184.215.14/missing\nText: s"));
		return url.pathname === "/p" ? new Response("Page P body", { headers: { "content-type": "text/plain" } }) : new Response("", { status: 404 });
	};
	const { published, publish } = collect();
	const result = await runWebSearch({ query: "q", includeContent: true }, ctx, publish);
	assert.equal(published.length, 2);
	const fetchId = published[1].id;
	assert.equal(result.details.fetchId, fetchId);
	assert.match(textOf(result), new RegExp(`Page content of 1/2 result URLs is stored as responseId "${fetchId}"`));
	assert.match(textOf(runGetSearchContent({ responseId: fetchId, urlIndex: 0 })), /^# p\n\nPage P body$/);
	assert.equal((await runWebSearch({ query: "q" }, ctx, publish)).details.fetchId, null);
});

test("fetch_content of one URL returns the content with the stored responseId", async () => {
	servePages({ "/a": "# Page A\n\nHello." });
	const { published, publish } = collect();
	const result = await runFetchContent({ url: "http://93.184.215.14/a" }, ctx, publish);
	const id = published[0].id;
	assert.equal(textOf(result), `# Page A\n\nHello.\n\n---\nFull content is stored as responseId "${id}". Use get_search_content({ responseId: "${id}", urlIndex: 0 }) to retrieve it.`);
	assert.deepEqual([result.details.title, result.details.totalChars, result.details.truncated, result.details.mode], ["Page A", 16, false, "readable"]);
});

test("a long page is cut at a line break and the rest is paged with get_search_content", async () => {
	const long = Array.from({ length: 2_000 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
	servePages({ "/long": long });
	const { published, publish } = collect();
	const result = await runFetchContent({ url: "http://93.184.215.14/long" }, ctx, publish);
	const output = textOf(result);
	assert.ok(output.length <= MAX_OUTPUT_CHARS);
	assert.equal(result.details.truncated, true);
	const shown = Number(output.match(/Showing (\d+) of/)?.[1]);
	assert.equal(long[shown - 1], "\n");
	const id = published[0].id;
	const next = runGetSearchContent({ responseId: id, urlIndex: 0, offset: shown, limit: 100 });
	assert.match(textOf(next), new RegExp(`^# long\\n\\n${long.slice(shown, shown + 100)}\\n\\n---\\nShowing chars ${shown}-${shown + 100} of ${long.length}\\. Use get_search_content`));
	assert.equal(next.details.nextOffset, shown + 100);
});

test("fetch_content of several URLs lists them; one failure does not fail the call", async () => {
	servePages({ "/a": "# A\n\naaa" });
	const { publish } = collect();
	const result = await runFetchContent({ urls: ["http://93.184.215.14/a", "http://93.184.215.14/missing", "http://93.184.215.14/a"] }, ctx, publish);
	assert.match(textOf(result), /^## Fetched URLs\n\n- A \(8 chars\)\n- http:\/\/93\.184\.215\.14\/missing: Error - HTTP 404: Not Found\n/);
	assert.deepEqual([result.details.urlCount, result.details.successful, result.isError], [2, 1, undefined]);
});

test("answer mode returns the model's answers with their usage, and a prompt alone implies answer mode", async () => {
	servePages({ "/a": "Page A text", "/b": "Page B text" });
	const { publish } = collect();
	const single = await runFetchContent({ url: "http://93.184.215.14/a", prompt: "What is A?" }, ctx, publish);
	assert.match(textOf(single), /^answer to: Question: What is A\?\n\n---\nOriginal source content is stored as responseId/);
	assert.deepEqual(single.usage, usage);
	const multi = await runFetchContent({ urls: ["http://93.184.215.14/a", "http://93.184.215.14/b"], mode: "answer", prompt: "Q" }, ctx, publish);
	assert.match(textOf(multi), /^## Page answers\n\n### a\nanswer to: Question: Q\n\n### b\nanswer to: Question: Q\n/);
	assert.equal(multi.usage?.totalTokens, 6);
});

test("fetch_content validates its arguments and names what it received", async () => {
	const { publish } = collect();
	assert.equal(textOf(await runFetchContent({ mode: "raw" }, ctx, publish)), "Error: No URL provided (received parameters: mode). Use the 'url' parameter, or 'urls' for parallel fetches.");
	assert.equal(textOf(await runFetchContent({ url: "http://93.184.215.14/a", mode: "answer" }, ctx, publish)), "Error: mode answer requires prompt.");
	assert.equal(textOf(await runFetchContent({ url: "http://93.184.215.14/a", mode: "raw", prompt: "q" }, ctx, publish)), "Error: prompt requires mode answer, not raw.");
	const failed = await runFetchContent({ url: "http://127.0.0.1/" }, ctx, publish);
	assert.equal(failed.isError, true);
	assert.match(textOf(failed), /Blocked internal address/);
});

test("get_search_content reads stored searches by queryIndex, lists several entries, and searches all of them", async () => {
	globalThis.fetch = async (_input, init) => {
		const query = JSON.parse(String(init?.body)).params.arguments.query;
		return new Response(exaReply(`Title: T ${query}\nURL: https://r.example/${query}\nText: about ${query} limits`));
	};
	const { published, publish } = collect();
	await runWebSearch({ queries: ["alpha", "beta"] }, ctx, publish);
	const id = published[0].id;
	assert.match(textOf(runGetSearchContent({ responseId: id, queryIndex: 1 })), /^# beta\n\n## Results for: "beta"\n\n\*\*Provider:\*\* exa\n\n### T beta\nhttps:\/\/r\.example\/beta\n\nabout beta limits/);
	assert.match(textOf(runGetSearchContent({ responseId: id })), /holds 2 stored queries\. Pass queryIndex to read one, or findText to search all of them\.\n0: "alpha" \(\d+ chars\)\n1: "beta"/);
	const found = runGetSearchContent({ responseId: id, findText: ["BETA LIMITS"] });
	assert.match(textOf(found), /## queryIndex 1: "beta"\n\nText matches \(case-insensitive\)/);
	assert.match(textOf(found), /No matches in queryIndex 0\./);
	assert.equal(found.details.matchCount, 1);
});

test("get_search_content finds text in a fetched page and reports bad requests", async () => {
	servePages({ "/a": "First line.\nThe Answer is here.\nLast line." });
	const { published, publish } = collect();
	await runFetchContent({ url: "http://93.184.215.14/a" }, ctx, publish);
	const id = published[0].id;
	const found = runGetSearchContent({ responseId: id, findText: "answer", findMode: "exact" });
	assert.match(textOf(found), /^# a\n\nText matches \(exact\): no matches/);
	assert.equal(runGetSearchContent({ responseId: id, findText: "answer" }).details.matchCount, 1);
	assert.match(textOf(runGetSearchContent({ responseId: id, urlIndex: 3 })), /urlIndex 3 is out of range/);
	assert.match(textOf(runGetSearchContent({ responseId: id, offset: 9_999 })), /Offset 9999 is out of range; valid range is 0-42\./);
	assert.match(textOf(runGetSearchContent({ responseId: id, findMode: "exact" })), /findMode requires findText/);
	assert.match(textOf(runGetSearchContent({ responseId: "nope" })), /No stored results for responseId "nope"/);
});
