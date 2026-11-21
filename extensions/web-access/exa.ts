// Exa search through its keyless MCP endpoint: one JSON-RPC `tools/call` over plain HTTP, no MCP
// client. `web_search_exa` takes only a query; filtered searches use `web_search_advanced_exa`
// and fall back to the basic tool with the filters written into the query.
import type { SearchOptions, SearchResponse } from "./search.ts";
import type { SearchResult } from "./storage.ts";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const TIMEOUT_MS = 60_000;
const SNIPPET_CHARS = 500;
const RECENCY_DAYS = { day: 1, week: 7, month: 30, year: 365 };

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text content of a `tools/call` reply, sent as SSE `data:` lines or as one JSON body. */
export function parseMcpReply(body: string): string {
	const payloads = body
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim());
	let reply: Json | undefined;
	for (const payload of payloads.length > 0 ? payloads : [body]) {
		try {
			const parsed: unknown = JSON.parse(payload);
			if (isJson(parsed) && (parsed.result || parsed.error)) {
				reply = parsed;
				break;
			}
		} catch {}
	}
	if (!reply) throw new Error("Exa MCP returned an empty response");
	if (isJson(reply.error)) throw new Error(`Exa MCP error: ${String(reply.error.message ?? "unknown error")}`);
	const result = isJson(reply.result) ? reply.result : {};
	// The free endpoint reports its rate limit with HTTP 200 and this flag.
	if (isJson(result._meta) && result._meta["ai.exa/rateLimited"] === true) throw new Error("Exa's free MCP search hit its rate limit (quota)");
	const text = (Array.isArray(result.content) ? result.content : [])
		.map((item) => (isJson(item) && typeof item.text === "string" ? item.text : ""))
		.find((item) => item.trim());
	if (result.isError === true) throw new Error(text?.trim() || "Exa MCP returned an error");
	if (!text) throw new Error("Exa MCP returned empty content");
	return text;
}

function snippet(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
}

function hostLabel(url: string, index: number): string {
	return URL.parse(url)?.hostname || `Source ${index + 1}`;
}

/** Results from the advanced tool's search JSON or the basic tool's `Title:`/`URL:`/`Text:` blocks. */
export function parseResults(text: string): SearchResult[] {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {}
	if (isJson(json) && Array.isArray(json.results)) {
		return json.results.flatMap((item, index) => {
			if (!isJson(item) || typeof item.url !== "string") return [];
			const highlights = Array.isArray(item.highlights) ? item.highlights.filter((part) => typeof part === "string").join(" ") : "";
			const body = highlights || (typeof item.text === "string" ? item.text : "");
			return [{ url: item.url, title: typeof item.title === "string" && item.title ? item.title : hostLabel(item.url, index), snippet: snippet(body) }];
		});
	}
	const results = text
		.split(/(?=^Title: )/m)
		.flatMap((block, index) => {
			const url = block.match(/^URL: (.+)/m)?.[1]?.trim();
			if (!url) return [];
			const title = block.match(/^Title: (.+)/m)?.[1]?.trim() || hostLabel(url, index);
			const body = block.match(/\nText: ([\s\S]*)/)?.[1] ?? block.match(/\nHighlights:\s*\n([\s\S]*)/)?.[1] ?? "";
			return [{ url, title, snippet: snippet(body.replace(/\n---\s*$/, "")) }];
		});
	if (results.length === 0) throw new Error(`Exa MCP returned no parseable results: ${text.trim().slice(0, 200)}`);
	return results;
}

async function callTool(tool: string, args: Json, signal?: AbortSignal): Promise<string> {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const response = await fetch(`${EXA_MCP_URL}?tools=${tool}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	const body = await response.text();
	if (!response.ok) throw new Error(`Exa MCP error ${response.status}: ${body.slice(0, 300)}`);
	return parseMcpReply(body);
}

function basicQuery(query: string, options: SearchOptions): string {
	const parts = [query];
	for (const domain of options.domainFilter ?? []) parts.push(domain.startsWith("-") ? `-site:${domain.slice(1)}` : `site:${domain}`);
	if (options.recencyFilter) parts.push(`past ${RECENCY_DAYS[options.recencyFilter]} days`);
	return parts.join(" ");
}

export async function searchExa(query: string, options: SearchOptions): Promise<SearchResponse> {
	const basic = () => callTool("web_search_exa", { query: basicQuery(query, options), numResults: options.numResults }, options.signal);
	if (!options.domainFilter?.length && !options.recencyFilter) return { answer: "", results: parseResults(await basic()) };
	const include = (options.domainFilter ?? []).filter((domain) => !domain.startsWith("-"));
	const exclude = (options.domainFilter ?? []).filter((domain) => domain.startsWith("-")).map((domain) => domain.slice(1));
	const args: Json = {
		query,
		type: "auto",
		numResults: options.numResults,
		enableHighlights: true,
		textMaxCharacters: 3000,
		...(include.length ? { includeDomains: include } : {}),
		...(exclude.length ? { excludeDomains: exclude } : {}),
		...(options.recencyFilter ? { startPublishedDate: new Date(Date.now() - RECENCY_DAYS[options.recencyFilter] * 86_400_000).toISOString() } : {}),
	};
	let text: string;
	try {
		text = await callTool("web_search_advanced_exa", args, options.signal);
	} catch (err) {
		if (options.signal?.aborted) throw err;
		// Not every deployment exposes the advanced tool.
		text = await basic();
	}
	return { answer: "", results: parseResults(text) };
}
