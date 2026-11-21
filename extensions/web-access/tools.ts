// What web_search, fetch_content and get_search_content do and return, without pi's registration
// and rendering (index.ts). Every result the model sees stays within MAX_OUTPUT_CHARS; the full
// text is stored and paged with get_search_content.
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { answerFromPage } from "./answer.ts";
import { type FetchedPage, type FetchMode, fetchPage } from "./extract.ts";
import { type FindMode, findText } from "./find.ts";
import { isAbort, PROVIDERS, type Provider, type Recency, type SearchOptions, type SearchResponse, search } from "./search.ts";
import { getResult, type QueryResult, type SessionEntryData, storeFetch, storeSearch } from "./storage.ts";

export const MAX_OUTPUT_CHARS = 30_000;
const CONCURRENCY = 3;

export type ToolResult = AgentToolResult<Record<string, unknown>>;
export type ToolContext = Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager">;
/** Appends a stored result to the session, so a resumed session can read it again. */
export type Publish = (data: SessionEntryData) => void;

export interface WebSearchParams {
	query?: string;
	queries?: string[];
	numResults?: number;
	/** "all" asks every provider and merges their answers and sources. */
	provider?: Provider | "auto" | "all";
	domainFilter?: string[];
	recencyFilter?: Recency;
	/** Also fetch every result page and store it, readable through the returned fetchId. */
	includeContent?: boolean;
}

export interface FetchContentParams {
	url?: string;
	urls?: string[];
	mode?: FetchMode;
	prompt?: string;
}

export interface GetSearchContentParams {
	responseId: string;
	queryIndex?: number;
	urlIndex?: number;
	offset?: number;
	limit?: number;
	findText?: string | string[];
	findMode?: FindMode;
}

function errorResult(message: string, details: Record<string, unknown> = {}): ToolResult {
	return { isError: true, content: [{ type: "text", text: `Error: ${message}` }], details: { error: message, ...details } };
}

function text(value: string, details: Record<string, unknown>, isError = false): ToolResult {
	return { ...(isError ? { isError } : {}), content: [{ type: "text", text: value }], details };
}

async function mapConcurrent<T, R>(items: readonly T[], run: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await run(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
	return results;
}

/**
 * Some models send an array argument as a JSON string (`queries: "[\"a\",\"b\"]"`), which fails
 * schema validation. Parses such strings back into string arrays before validation.
 */
export function parseStringArrays(args: unknown, keys: readonly string[]): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const input = args as Record<string, unknown>;
	const output = { ...input };
	for (const key of keys) {
		const value = input[key];
		if (typeof value !== "string" || !value.trim().startsWith("[")) continue;
		try {
			const parsed: unknown = JSON.parse(value);
			if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) output[key] = parsed;
		} catch {
			throw new Error(`${key} must be an array of strings; the given value is not valid JSON`);
		}
	}
	return output;
}

/** Cuts `content` at `end`, moving back so a surrogate pair is never split. */
function safeEnd(content: string, start: number, end: number): number {
	if (end >= content.length || end <= start) return end;
	const code = content.charCodeAt(end - 1);
	return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

function bounded(body: string, footer: string): { text: string; truncated: boolean } {
	if (body.length + footer.length <= MAX_OUTPUT_CHARS) return { text: body + footer, truncated: false };
	const marker = "\n\n---\n[Output truncated.]";
	return { text: body.slice(0, safeEnd(body, 0, MAX_OUTPUT_CHARS - marker.length - footer.length)) + marker + footer, truncated: true };
}

function formatSources(query: QueryResult): string {
	if (query.results.length === 0) return query.answer ? `${query.answer}\n\n---\n\n**Sources:**\nNo sources returned.` : "No results found.";
	const sources = query.results
		.map((result, index) => {
			const lines = [`${index + 1}. ${result.title}`];
			if (result.url !== result.title) lines.push(`   ${result.url}`);
			// Without an answer the snippets are the only text the search returned.
			if (!query.answer && result.snippet) lines.push(`   ${result.snippet}`);
			return lines.join("\n");
		})
		.join("\n\n");
	return query.answer ? `${query.answer}\n\n---\n\n**Sources:**\n${sources}` : sources;
}

/** Every provider at once: answers labeled by provider, sources deduplicated in provider order. Fails only when all fail. */
async function searchAll(query: string, options: SearchOptions, ctx: ToolContext): Promise<SearchResponse & { provider: string }> {
	const settled = await Promise.allSettled(PROVIDERS.map((provider) => search(query, options, provider, ctx.modelRegistry)));
	if (options.signal?.aborted) throw new Error("Aborted");
	const ok = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
	if (ok.length === 0) {
		throw new Error(settled.map((outcome) => (outcome.status === "rejected" ? (outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)) : "")).join("\n"));
	}
	const seen = new Set<string>();
	return {
		answer: ok
			.filter((response) => response.answer.trim())
			.map((response) => (ok.length > 1 ? `**${response.provider}:** ${response.answer}` : response.answer))
			.join("\n\n"),
		results: ok.flatMap((response) => response.results).filter((result) => !seen.has(result.url) && seen.add(result.url)),
		provider: ok.map((response) => response.provider).join("+"),
	};
}

/** Splits a `query` that holds a JSON array of strings, which some models send instead of `queries`. */
function queryList(params: WebSearchParams): string[] {
	let list = params.queries ?? [];
	if (list.length === 0 && params.query !== undefined) {
		const parsed = parseStringArrays({ query: params.query }, ["query"]) as { query: string | string[] };
		list = Array.isArray(parsed.query) ? parsed.query : [parsed.query];
	}
	return list.map((query) => query.trim()).filter(Boolean);
}

export async function runWebSearch(params: WebSearchParams, ctx: ToolContext, publish: Publish, signal?: AbortSignal): Promise<ToolResult> {
	const queries = queryList(params);
	if (queries.length === 0) return errorResult("No query provided. Use 'query' or 'queries' parameter.");
	const options = { numResults: params.numResults ?? 5, domainFilter: params.domainFilter, recencyFilter: params.recencyFilter, signal };
	const results = await mapConcurrent(queries, async (query): Promise<QueryResult> => {
		try {
			const response = params.provider === "all" ? await searchAll(query, options, ctx) : await search(query, options, params.provider ?? "auto", ctx.modelRegistry);
			return { query, answer: response.answer, results: response.results, error: null, provider: response.provider };
		} catch (err) {
			if (isAbort(err, signal)) throw err;
			return { query, answer: "", results: [], error: err instanceof Error ? err.message : String(err) };
		}
	});
	const entry = storeSearch(results);
	publish(entry);
	const providers = results.map((result) => result.provider ?? "none");
	let body =
		results.length === 1 ? `**Provider:** ${providers[0]}\n\n` : `**Providers used:** ${providers.map((name, index) => `Query ${index + 1}: ${name}`).join("; ")}\n\n`;
	for (const result of results) {
		if (results.length > 1) body += `## Query: "${result.query}"\n\n`;
		body += result.error ? `Error: ${result.error}\n\n` : `${formatSources(result)}\n\n`;
	}
	const more = results.length > 1 ? `; repeat with queryIndex 1 through ${results.length - 1}` : "";
	let footer = `\n---\nFull search results are stored as responseId "${entry.id}". Use get_search_content({ responseId: "${entry.id}", queryIndex: 0 }) to read them${more}.`;
	let fetchId: string | null = null;
	const urls = [...new Set(results.flatMap((result) => result.results.map((source) => source.url)))];
	if (params.includeContent && urls.length > 0) {
		const pages = await mapConcurrent(urls, (url) => fetchPage(url, "readable", signal));
		if (signal?.aborted) throw new Error("Aborted");
		const fetched = storeFetch(pages);
		publish(fetched);
		fetchId = fetched.id;
		const ok = pages.filter((page) => !page.error).length;
		footer += `\nPage content of ${ok}/${urls.length} result URLs is stored as responseId "${fetchId}". Use get_search_content({ responseId: "${fetchId}", urlIndex: 0 }) to read it; urlIndex follows the source order above.`;
	}
	const output = bounded(body.trim(), footer);
	const successful = results.filter((result) => !result.error).length;
	return text(
		output.text,
		{
			queries,
			queryCount: queries.length,
			successfulQueries: successful,
			totalResults: results.reduce((total, result) => total + result.results.length, 0),
			searchId: entry.id,
			fetchId,
			queryProviders: results.map((result) => ({ query: result.query, providers: result.provider ? result.provider.split("+") : [] })),
			truncated: output.truncated,
		},
		successful === 0,
	);
}

function addUsage(left: Usage, right: Usage): Usage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

export async function runFetchContent(params: FetchContentParams, ctx: ToolContext, publish: Publish, signal?: AbortSignal): Promise<ToolResult> {
	const urls = [...new Set((params.urls?.length ? params.urls : [params.url ?? ""]).map((url) => url.trim()).filter(Boolean))];
	if (urls.length === 0) {
		// Naming what arrived tells dropped tool-call arguments apart from malformed ones.
		const received = Object.keys(params).join(", ") || "none";
		return errorResult(`No URL provided (received parameters: ${received}). Use the 'url' parameter, or 'urls' for parallel fetches.`);
	}
	const prompt = params.prompt?.trim();
	const mode = params.mode ?? (prompt ? "answer" : "readable");
	if (mode === "answer" && !prompt) return errorResult("mode answer requires prompt.");
	if (mode !== "answer" && prompt) return errorResult(`prompt requires mode answer, not ${mode}.`);

	const pages = await mapConcurrent(urls, (url) => fetchPage(url, mode, signal));
	if (signal?.aborted) throw new Error("Aborted");
	const entry = storeFetch(pages);
	publish(entry);
	const responseId = entry.id;

	let usage: Usage | undefined;
	const shown: FetchedPage[] =
		mode === "answer" && prompt
			? await mapConcurrent(pages, async (page) => {
					if (page.error) return page;
					try {
						const answer = await answerFromPage(prompt, page, ctx, signal);
						usage = usage ? addUsage(usage, answer.usage) : answer.usage;
						return { ...page, content: answer.text };
					} catch (err) {
						if (isAbort(err, signal)) throw err;
						return { ...page, error: `Page answer failed: ${err instanceof Error ? err.message : String(err)}` };
					}
				})
			: pages;
	const successful = shown.filter((page) => !page.error).length;
	const details: Record<string, unknown> = { urls, urlCount: urls.length, successful, responseId, mode, ...(prompt ? { prompt } : {}) };
	const withUsage = (result: ToolResult): ToolResult => (usage ? { ...result, usage } : result);
	const sourceNote = mode === "answer" ? "Original source content" : "Full content";

	if (urls.length === 1) {
		const page = shown[0];
		if (page.error) return withUsage(errorResult(page.error, { ...details, title: page.title, status: page.status }));
		let end = safeEnd(page.content, 0, Math.min(page.content.length, MAX_OUTPUT_CHARS - 500));
		if (end < page.content.length) {
			const lineBreak = page.content.lastIndexOf("\n", end);
			if (lineBreak >= end * 0.8) end = lineBreak + 1;
		}
		const truncated = end < page.content.length;
		const footer = truncated
			? mode === "answer"
				? `\n\n---\nShowing ${end} of ${page.content.length} chars. ${sourceNote} is stored as responseId "${responseId}"; get_search_content({ responseId: "${responseId}", urlIndex: 0 }) reads it.`
				: `\n\n---\nShowing ${end} of ${page.content.length} chars. Use get_search_content({ responseId: "${responseId}", urlIndex: 0, offset: ${end} }) for the next slice.`
			: `\n\n---\n${sourceNote} is stored as responseId "${responseId}". Use get_search_content({ responseId: "${responseId}", urlIndex: 0 }) to retrieve it.`;
		return withUsage(text(page.content.slice(0, end) + footer, { ...details, title: page.title, totalChars: page.content.length, truncated, status: page.status, mimeType: page.mimeType }));
	}

	let output = mode === "answer" ? "## Page answers\n" : "## Fetched URLs\n\n";
	let budget = MAX_OUTPUT_CHARS - 1_000;
	for (const page of shown) {
		if (mode !== "answer") {
			output += page.error ? `- ${page.url}: Error - ${page.error}\n` : `- ${page.title || page.url} (${page.content.length} chars)\n`;
		} else if (page.error) {
			output += `\n### ${page.url}\nError: ${page.error}\n`;
		} else {
			const answer = page.content.slice(0, Math.max(0, budget));
			budget -= answer.length;
			const marker = answer.length < page.content.length ? "\n[answer cut at the output limit; fetch fewer URLs per call for complete answers]" : "";
			output += `\n### ${page.title || page.url}\n${answer}${marker}\n`;
		}
	}
	output += `\n---\n${sourceNote} is stored as responseId "${responseId}". Use get_search_content({ responseId: "${responseId}", urlIndex: 0 }) to read the first page; urlIndex follows the order above.`;
	return withUsage(text(output, { ...details, totalChars: shown.reduce((total, page) => total + page.content.length, 0) }, successful === 0));
}

interface Entry {
	label: string;
	title: string;
	content: string | null;
	error: string | null;
}

function formatQueryResults(query: QueryResult): string {
	let output = `## Results for: "${query.query}"\n\n`;
	if (query.provider) output += `**Provider:** ${query.provider}\n\n`;
	if (query.answer) output += `${query.answer}\n\n---\n\n`;
	for (const result of query.results) output += `### ${result.title}\n${result.url}${result.snippet ? `\n\n${result.snippet}` : ""}\n\n`;
	return output;
}

/** A responseId with several entries and no index: list them, or search all of them with findText. */
function readAll(params: GetSearchContentParams, indexKey: "queryIndex" | "urlIndex", entries: Entry[]): ToolResult {
	const noun = indexKey === "queryIndex" ? "queries" : "URLs";
	const title = `${entries.length} stored ${noun}`;
	if (params.findText === undefined) {
		const lines = entries.map((entry, index) => `${index}: ${entry.label} (${entry.content === null ? `error: ${entry.error}` : `${entry.content.length} chars`})`);
		const head = `responseId "${params.responseId}" holds ${title}. Pass ${indexKey} to read one, or findText to search all of them.`;
		return text(bounded([head, ...lines].join("\n"), "").text, { responseId: params.responseId, title });
	}
	const mode = params.findMode ?? "case-insensitive";
	const queries = typeof params.findText === "string" ? [params.findText] : params.findText;
	const sections: string[] = [`findText searched ${title} in responseId "${params.responseId}".`];
	let matchCount = 0;
	let returnedMatches = 0;
	const missing: number[] = [];
	for (const [index, entry] of entries.entries()) {
		if (entry.content === null) continue;
		const found = findText(entry.content, queries, mode);
		matchCount += found.matchCount;
		if (found.matchCount === 0) {
			missing.push(index);
			continue;
		}
		returnedMatches += found.returnedMatches;
		sections.push(`## ${indexKey} ${index}: ${entry.label}\n\n${found.text}`);
	}
	if (missing.length > 0) sections.push(`No matches in ${indexKey} ${missing.join(", ")}.`);
	const failed = entries.flatMap((entry, index) => (entry.content === null ? [`${index} (${entry.error})`] : []));
	if (failed.length > 0) sections.push(`Not searched (failed): ${indexKey} ${failed.join(", ")}.`);
	return text(bounded(sections.join("\n\n"), "").text, { responseId: params.responseId, title, findMode: mode, matchCount, returnedMatches });
}

export function runGetSearchContent(params: GetSearchContentParams): ToolResult {
	if (params.findMode !== undefined && params.findText === undefined) return errorResult("findMode requires findText; provide findText or omit findMode.");
	const stored = getResult(params.responseId);
	if (!stored) return errorResult(`No stored results for responseId "${params.responseId}". Use a responseId returned by web_search or fetch_content.`, { responseId: params.responseId });

	const indexKey = stored.type === "search" ? "queryIndex" : "urlIndex";
	const entries: Entry[] =
		stored.type === "search"
			? stored.queries.map((query) => ({ label: `"${query.query}"`, title: query.query, content: query.error ? null : formatQueryResults(query), error: query.error }))
			: stored.urls.map((page) => ({
					label: page.title && page.title !== page.url ? `${page.title} — ${page.url}` : page.url,
					title: page.title || page.url,
					content: page.error ? null : page.content,
					error: page.error,
				}));
	const requested = stored.type === "search" ? params.queryIndex : params.urlIndex;
	if (requested === undefined && entries.length > 1) return readAll(params, indexKey, entries);
	const index = requested ?? 0;
	const entry = entries[index];
	if (!entry) {
		const available = entries.map((item, position) => `${position}: ${item.label}`).join("\n  ");
		return errorResult(`${indexKey} ${index} is out of range for responseId "${params.responseId}". Available:\n  ${available || "none"}`);
	}
	const base = { responseId: params.responseId, title: entry.title, ...(stored.type === "fetch" ? { url: stored.urls[index].url } : { query: entry.title }) };
	if (entry.content === null) return errorResult(`Stored entry ${indexKey} ${index} failed: ${entry.error}`, base);
	const content = entry.content;

	if (params.findText !== undefined) {
		const mode = params.findMode ?? "case-insensitive";
		const found = findText(content, typeof params.findText === "string" ? [params.findText] : params.findText, mode);
		return text(`# ${entry.title}\n\n${found.text}`, { ...base, contentLength: content.length, findMode: mode, matchCount: found.matchCount, returnedMatches: found.returnedMatches });
	}

	const offset = params.offset ?? 0;
	const limit = params.limit ?? MAX_OUTPUT_CHARS;
	if (offset > content.length) return errorResult(`Offset ${offset} is out of range; valid range is 0-${content.length}.`, { ...base, contentLength: content.length });
	// Room for the title and the continuation line keeps the page within MAX_OUTPUT_CHARS.
	const end = safeEnd(content, offset, Math.min(offset + Math.min(limit, MAX_OUTPUT_CHARS - 500), content.length));
	const hasMore = end < content.length;
	let output = `# ${entry.title}\n\n${content.slice(offset, end)}`;
	if (hasMore || offset > 0) output += `\n\n---\nShowing chars ${offset}-${end} of ${content.length}.`;
	if (hasMore) output += ` Use get_search_content({ responseId: "${params.responseId}", ${indexKey}: ${index}, offset: ${end}, limit: ${limit} }) for the next slice.`;
	return text(output, { ...base, contentLength: content.length, offset, limit, returnedChars: end - offset, nextOffset: hasMore ? end : null, truncated: hasMore });
}
