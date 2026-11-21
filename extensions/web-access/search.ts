// Routes one search query to OpenAI hosted search or Exa.
//
// `provider: "auto"` follows `searchRouting` in `<agentDir>/web-search.json`: providers in order,
// moving to the next one when a provider is not logged in or fails with an error kind listed in
// `fallbackOn`. An explicit provider is tried alone.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { searchExa } from "./exa.ts";
import { resolveOpenAIAuth, searchOpenAI } from "./openai-search.ts";
import type { SearchResult } from "./storage.ts";

export const PROVIDERS = ["openai", "exa"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type Recency = "day" | "week" | "month" | "year";

export interface SearchOptions {
	numResults: number;
	domainFilter?: string[];
	recencyFilter?: Recency;
	signal?: AbortSignal;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
}

const ERROR_KINDS = ["unsupported", "transient", "quota", "network", "invalid-response", "auth", "invalid-request", "empty", "unknown"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface Routing {
	providers: Provider[];
	fallbackOn: ErrorKind[];
}

const DEFAULT_ROUTING: Routing = { providers: ["openai", "exa"], fallbackOn: ["unsupported", "transient", "quota", "network", "invalid-response"] };

export function configPath(): string {
	return join(getAgentDir(), "web-search.json");
}

/** `searchRouting` from web-search.json; unknown providers and kinds are ignored. */
export function loadRouting(): Routing {
	if (!existsSync(configPath())) return DEFAULT_ROUTING;
	let config: unknown;
	try {
		config = JSON.parse(readFileSync(configPath(), "utf8"));
	} catch (err) {
		throw new Error(`Failed to parse ${configPath()}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const routing = typeof config === "object" && config !== null ? (config as { searchRouting?: unknown }).searchRouting : undefined;
	if (typeof routing !== "object" || routing === null) return DEFAULT_ROUTING;
	const { providers, fallbackOn } = routing as { providers?: unknown; fallbackOn?: unknown };
	const known: readonly unknown[] = PROVIDERS;
	const ordered = Array.isArray(providers) ? providers.filter((provider): provider is Provider => known.includes(provider)) : [];
	return {
		providers: ordered.length > 0 ? [...new Set(ordered)] : DEFAULT_ROUTING.providers,
		fallbackOn: Array.isArray(fallbackOn) ? ERROR_KINDS.filter((kind) => fallbackOn.includes(kind)) : DEFAULT_ROUTING.fallbackOn,
	};
}

export function isAbort(err: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

export function classifyError(err: unknown): ErrorKind {
	const message = err instanceof Error ? err.message : String(err);
	const text = message.toLowerCase().replace(/_/g, " ");
	const status = Number(message.match(/\b(?:error|status|http)\s+(\d{3})\b/i)?.[1] ?? Number.NaN);
	if (err instanceof Error && err.name === "TimeoutError") return "network";
	if (status === 401 || status === 403) return "auth";
	if ((status === 400 || status === 422) && /web.?search|tool/.test(text) && /not supported|unsupported|unknown|unrecognized/.test(text)) return "unsupported";
	if (status === 400 || status === 422) return "invalid-request";
	if (status === 402 || status === 429) return "quota";
	if (status === 408 || status === 425 || status >= 500) return "transient";
	if (/rate limit|quota|too many requests|usage limit/.test(text)) return "quota";
	if (/unauthorized|forbidden|authentication error|permission error|invalid api key/.test(text)) return "auth";
	if (/invalid json|no parseable|invalid response|empty response|empty content|no web search call|no answer or sources/.test(text)) return "invalid-response";
	if (/temporar|service unavailable|server error|internal error|overloaded/.test(text)) return "transient";
	if (err instanceof TypeError || /fetch failed|network|econnreset|econnrefused|enotfound|etimedout|timed out|socket/.test(text)) return "network";
	return "unknown";
}

async function searchWith(provider: Provider, query: string, options: SearchOptions, registry: ExtensionContext["modelRegistry"]): Promise<SearchResponse | "unavailable"> {
	if (provider === "exa") return searchExa(query, options);
	const auth = await resolveOpenAIAuth(registry);
	return auth ? searchOpenAI(query, options, auth) : "unavailable";
}

export async function search(
	query: string,
	options: SearchOptions,
	requested: Provider | "auto",
	registry: ExtensionContext["modelRegistry"],
): Promise<SearchResponse & { provider: Provider }> {
	const routing = requested === "auto" ? loadRouting() : { providers: [requested], fallbackOn: [] };
	const diagnostics: string[] = [];
	let firstEmpty: (SearchResponse & { provider: Provider }) | undefined;
	for (const provider of routing.providers) {
		try {
			const response = await searchWith(provider, query, options, registry);
			if (response === "unavailable") {
				diagnostics.push(`${provider}: unavailable (log in to openai-codex or openai with /login)`);
				continue;
			}
			const empty = response.results.length === 0 && !response.answer.trim();
			if (!empty || !routing.fallbackOn.includes("empty")) return { ...response, provider };
			diagnostics.push(`${provider} [empty]`);
			firstEmpty ??= { ...response, provider };
		} catch (err) {
			if (isAbort(err, options.signal)) throw err;
			const kind = classifyError(err);
			const line = `${provider} [${kind}]: ${err instanceof Error ? err.message : String(err)}`;
			if (!routing.fallbackOn.includes(kind)) throw new Error(diagnostics.length > 0 ? `${diagnostics.join("\n")}\n${line}` : line);
			diagnostics.push(line);
		}
	}
	if (firstEmpty) return firstEmpty;
	throw new Error(`No search provider succeeded:\n  - ${diagnostics.join("\n  - ")}`);
}
