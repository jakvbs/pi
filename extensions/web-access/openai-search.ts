// OpenAI hosted web search: a Responses API request whose model must call the server-side
// `web_search` tool. Credentials come from pi's own login: the ChatGPT subscription
// (`openai-codex`, sent to the Codex backend) or an `openai` API key for api.openai.com.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SearchOptions, SearchResponse } from "./search.ts";
import type { SearchResult } from "./storage.ts";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const TIMEOUT_MS = 60_000;
const PROVIDERS = ["openai-codex", "openai"] as const;
const RECENCY_LABELS = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };

type ModelRegistry = ExtensionContext["modelRegistry"];

export interface OpenAIAuth {
	provider: (typeof PROVIDERS)[number];
	model: string;
	apiKey: string;
	headers: Record<string, string>;
	url: string;
}

/** The model that runs the search: the newest low-cost "luna" model, else the newest plain or versioned GPT id, never "pro"/"ultra" price tiers. */
export function pickSearchModel<T extends { id: string }>(models: readonly T[]): T | undefined {
	const candidates = models
		.filter((model) => !model.id.split("-").some((segment) => segment === "pro" || segment === "ultra"))
		.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
	return (
		candidates.find((model) => model.id.includes("luna")) ??
		candidates.find((model) => /^gpt-\d+(\.\d+)?$/.test(model.id)) ??
		candidates.find((model) => /^gpt-\d/.test(model.id)) ??
		candidates[0]
	);
}

/** The ChatGPT account id claim of a Codex access token (a JWT). */
function chatgptAccountId(token: string): string | undefined {
	try {
		const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
		const auth = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)["https://api.openai.com/auth"] : undefined;
		const id = typeof auth === "object" && auth !== null ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
		return typeof id === "string" && id ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Credentials of the first logged-in provider, or undefined when neither is usable. */
export async function resolveOpenAIAuth(registry: ModelRegistry): Promise<OpenAIAuth | undefined> {
	for (const provider of PROVIDERS) {
		const model = pickSearchModel(registry.getAll().filter((candidate) => candidate.provider === provider));
		if (!model) continue;
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) continue;
		const baseUrl = (auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "");
		// An `openai` key for a gateway may not support Responses web search; only the official API is used.
		if (provider === "openai" && baseUrl !== "https://api.openai.com/v1") continue;
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(auth.headers ?? {})) if (value !== null) headers[name] = value;
		headers.Authorization = `Bearer ${auth.apiKey}`;
		headers["Content-Type"] = "application/json";
		headers["OpenAI-Beta"] = "responses=experimental";
		if (provider === "openai-codex") {
			const accountId = chatgptAccountId(auth.apiKey);
			if (accountId) headers["chatgpt-account-id"] = accountId;
			headers.originator = "pi";
		}
		return { provider, model: model.id, apiKey: auth.apiKey, headers, url: provider === "openai-codex" ? CODEX_RESPONSES_URL : OPENAI_RESPONSES_URL };
	}
	return undefined;
}

function domainFilters(domainFilter: string[] | undefined): { allowed: string[]; blocked: string[] } {
	const allowed: string[] = [];
	const blocked: string[] = [];
	for (const raw of domainFilter ?? []) {
		const value = raw.trim();
		const domain = value
			.replace(/^-/, "")
			.replace(/^https?:\/\//, "")
			.replace(/\/.*$/, "")
			.toLowerCase();
		if (domain) (value.startsWith("-") ? blocked : allowed).push(domain);
	}
	return { allowed, blocked };
}

export function buildRequest(query: string, options: SearchOptions, model: string): Record<string, unknown> {
	const { allowed, blocked } = domainFilters(options.domainFilter);
	const instructions = [
		"Search the web and return a concise answer grounded only in the web results.",
		"Include clickable source citations in the response text when possible.",
		...(options.recencyFilter ? [`Prefer sources from the ${RECENCY_LABELS[options.recencyFilter]}.`] : []),
		`Prefer around ${options.numResults} distinct sources.`,
		...(allowed.length ? [`Only use sources from: ${allowed.join(", ")}.`] : []),
		...(blocked.length ? [`Do not use sources from: ${blocked.join(", ")}.`] : []),
	];
	const filters = {
		...(allowed.length ? { allowed_domains: allowed } : {}),
		...(blocked.length ? { blocked_domains: blocked } : {}),
	};
	return {
		model,
		instructions: instructions.join(" "),
		input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
		tools: [{ type: "web_search", ...(allowed.length || blocked.length ? { filters } : {}) }],
		include: ["web_search_call.action.sources"],
		store: false,
		stream: true,
		tool_choice: "required",
		parallel_tool_calls: true,
	};
}

type Item = Record<string, unknown>;

function asItems(value: unknown): Item[] {
	return Array.isArray(value) ? value.filter((item): item is Item => typeof item === "object" && item !== null) : [];
}

/** The output items of a streamed (SSE) or plain JSON Responses API reply. Throws on a stream error event. */
export function parseOutput(body: string): Item[] {
	const trimmed = body.trim();
	if (trimmed.startsWith("{")) return asItems((JSON.parse(trimmed) as Item).output);
	const items: Item[] = [];
	let completed: Item[] | undefined;
	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		let event: Item;
		try {
			event = JSON.parse(line.slice(6));
		} catch {
			continue;
		}
		const response = typeof event.response === "object" && event.response !== null ? (event.response as Item) : undefined;
		const error = event.type === "error" ? (event.error ?? event) : response?.error;
		if (error || event.type === "response.failed") {
			const detail = typeof error === "object" && error !== null ? (error as Item) : { message: typeof error === "string" ? error : event.message };
			const kind = [detail.type, detail.code].filter((part) => typeof part === "string").join("/");
			const message = typeof detail.message === "string" && detail.message ? detail.message : "response stream failed (invalid response)";
			throw new Error(`OpenAI API stream error${kind ? ` (${kind})` : ""}: ${message}`);
		}
		if (event.type === "response.output_item.done") items.push(...asItems([event.item]));
		if (response && (event.type === "response.completed" || event.type === "response.done" || event.type === "response.incomplete")) {
			const output = asItems(response.output);
			if (output.length > 0) completed = output;
		}
	}
	const output = completed ?? items;
	if (output.length === 0) throw new Error("OpenAI API returned no parseable response output");
	return output;
}

function cleanUrl(raw: string): string {
	try {
		const url = new URL(raw);
		if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
		return url.toString();
	} catch {
		return raw;
	}
}

function textParts(output: Item[]): Item[] {
	return output.filter((item) => item.type === "message").flatMap((item) => asItems(item.content));
}

/** Answer text and sources: cited URLs first (with the sentence around the citation), then the other sources the search read. */
export function toSearchResponse(output: Item[], numResults: number): SearchResponse {
	if (!output.some((item) => item.type === "web_search_call")) throw new Error("OpenAI web_search returned no web_search_call");
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	const add = (url: unknown, title: unknown, snippet = "") => {
		if (typeof url !== "string" || !url.trim()) return;
		const clean = cleanUrl(url);
		if (seen.has(clean)) return;
		seen.add(clean);
		results.push({ url: clean, title: typeof title === "string" && title.trim() ? title : clean, snippet });
	};
	for (const part of textParts(output)) {
		const text = typeof part.text === "string" ? part.text : "";
		for (const annotation of asItems(part.annotations)) {
			if (annotation.type !== "url_citation") continue;
			const start = typeof annotation.start_index === "number" ? annotation.start_index : -1;
			const end = typeof annotation.end_index === "number" ? annotation.end_index : -1;
			const around = start >= 0 && end >= 0 ? text.slice(Math.max(0, start - 100), Math.min(text.length, end + 100)) : "";
			const snippet = around.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
			add(annotation.url, annotation.title, snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet);
		}
	}
	for (const call of output.filter((item) => item.type === "web_search_call")) {
		const action = typeof call.action === "object" && call.action !== null ? (call.action as Item) : {};
		for (const source of [...asItems(action.sources), ...asItems(call.sources), ...asItems(call.results)]) {
			add(source.url ?? source.source_website_url, source.title ?? source.caption);
		}
	}
	const answer = textParts(output)
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.filter((text) => text.trim())
		.join("\n")
		.trim();
	if (!answer && results.length === 0) throw new Error("OpenAI web_search returned no answer or sources");
	return { answer, results: results.slice(0, numResults) };
}

export async function searchOpenAI(query: string, options: SearchOptions, auth: OpenAIAuth): Promise<SearchResponse> {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const response = await fetch(auth.url, {
		method: "POST",
		headers: auth.headers,
		body: JSON.stringify(buildRequest(query, options, auth.model)),
		signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
	});
	const body = await response.text();
	if (!response.ok) throw new Error(`OpenAI API error ${response.status}: ${body.split(auth.apiKey).join("[redacted]").slice(0, 300)}`);
	return toSearchResponse(parseOutput(body), options.numResults);
}
