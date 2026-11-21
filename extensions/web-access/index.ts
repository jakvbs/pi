// Web access for pi: web_search (OpenAI hosted search, Exa), fetch_content (pages, PDFs, GitHub
// repositories, answers from pages) and get_search_content (stored results by responseId).
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { ENTRY_TYPE, restoreFromBranch, type SessionEntryData } from "./storage.ts";
import { MAX_OUTPUT_CHARS, parseStringArrays, runFetchContent, runGetSearchContent, runWebSearch, type ToolResult } from "./tools.ts";

const webSearchParams = Type.Object({
	query: Type.Optional(Type.String()),
	queries: Type.Optional(Type.Array(Type.String(), { description: "Run concurrently (up to three at a time); vary the angle" })),
	numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Default 5" })),
	provider: Type.Optional(StringEnum(["auto", "openai", "exa", "all"] as const, { description: "Omit for the configured routing; all asks every provider" })),
	recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"] as const)),
	domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Prefix - to exclude" })),
	includeContent: Type.Optional(Type.Boolean({ description: "Also fetch and store every result page" })),
});

const fetchContentParams = Type.Object({
	url: Type.Optional(Type.String()),
	urls: Type.Optional(Type.Array(Type.String())),
	mode: Type.Optional(
		StringEnum(["readable", "raw", "answer"] as const, {
			description: "readable (default): extract readable content as markdown; raw: return the exact textual body; answer: answer the prompt using only the fetched content",
		}),
	),
	prompt: Type.Optional(Type.String({ description: "Question for answer mode" })),
});

const getSearchContentParams = Type.Object({
	responseId: Type.String(),
	queryIndex: Type.Optional(Type.Integer({ minimum: 0 })),
	urlIndex: Type.Optional(Type.Integer({ minimum: 0 })),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_CHARS, description: "Characters, default the maximum" })),
	findText: Type.Optional(
		Type.Union(
			[Type.String({ minLength: 1, maxLength: 500 }), Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 })],
			{ description: "Find passages instead of paging" },
		),
	),
	findMode: Type.Optional(StringEnum(["exact", "case-insensitive"] as const)),
});

function title(theme: Theme, name: string, target: string): string {
	return theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("accent", target);
}

function list(theme: Theme, items: string[]): string[] {
	const lines = items.slice(0, 5).map((item) => theme.fg("muted", `  ${item}`));
	if (items.length > 5) lines.push(theme.fg("muted", `  ... and ${items.length - 5} more`));
	return lines;
}

/** A status line from the result details; expanding shows the start of what the model received. */
function renderResult(status: (details: Record<string, unknown>) => string) {
	return (result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme) => {
		if (options.isPartial) return new Text(theme.fg("accent", "working..."), 0, 0);
		const body = result.content.find((part) => part.type === "text")?.text ?? "";
		const error = result.details.error;
		const line = typeof error === "string" ? theme.fg("error", `Error: ${error}`) : theme.fg(result.isError ? "error" : "success", status(result.details));
		if (!options.expanded) return new Text(line, 0, 0);
		return new Text(`${line}\n${theme.fg("dim", body.length > 2_000 ? `${body.slice(0, 2_000)}...` : body)}`, 0, 0);
	};
}

export default function webAccess(pi: ExtensionAPI) {
	const publish = (data: SessionEntryData) => pi.appendEntry(ENTRY_TYPE, data);
	const restore = (_event: unknown, ctx: ExtensionContext) => {
		restoreFromBranch(ctx.sessionManager.getBranch());
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web for sources or answers. Full results are stored for get_search_content by responseId. Prefer 2-4 varied queries.",
		promptSnippet: "Web research. Prefer {queries:[...]} with 2-4 varied angles; omit provider unless overriding the default.",
		parameters: webSearchParams,
		prepareArguments: (args) => parseStringArrays(args, ["queries", "domainFilter"]) as Static<typeof webSearchParams>,
		execute: (_id, params, signal, _onUpdate, ctx) => runWebSearch(params, ctx, publish, signal),
		renderCall(args, theme) {
			const queries = args.queries ?? (args.query ? [args.query] : []);
			if (queries.length <= 1) return new Text(title(theme, "search", queries[0] ? `"${queries[0]}"` : "(no query)"), 0, 0);
			return new Text([title(theme, "search", `${queries.length} queries`), ...list(theme, queries.map((query) => `"${query}"`))].join("\n"), 0, 0);
		},
		renderResult: renderResult((details) =>
			details.queryCount === 1 ? `${details.totalResults} sources` : `${details.successfulQueries}/${details.queryCount} queries, ${details.totalResults} sources`,
		),
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch web pages, PDFs and GitHub repositories (cloned locally). Full content is stored for retrieval with get_search_content.",
		promptSnippet: 'Use to fetch URL content and GitHub repos; mode "answer" with a prompt returns only the answer to that question.',
		parameters: fetchContentParams,
		prepareArguments: (args) => parseStringArrays(args, ["urls"]) as Static<typeof fetchContentParams>,
		execute: (_id, params, signal, _onUpdate, ctx) => runFetchContent(params, ctx, publish, signal),
		renderCall(args, theme) {
			const urls = args.urls?.length ? args.urls : args.url ? [args.url] : [];
			const lines = urls.length <= 1 ? [title(theme, "fetch", urls[0] ?? "(no URL)")] : [title(theme, "fetch", `${urls.length} URLs`), ...list(theme, urls)];
			if (args.mode && args.mode !== "readable") lines.push(theme.fg("dim", "  mode: ") + theme.fg("warning", args.mode));
			if (args.prompt) lines.push(theme.fg("dim", "  prompt: ") + theme.fg("muted", `"${args.prompt.length > 250 ? `${args.prompt.slice(0, 247)}...` : args.prompt}"`));
			return new Text(lines.join("\n"), 0, 0);
		},
		renderResult: renderResult((details) =>
			details.urlCount === 1
				? `${details.title || "Untitled"} (${details.totalChars} chars)${details.truncated ? " [truncated]" : ""}`
				: `${details.successful}/${details.urlCount} URLs (content stored)`,
		),
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Page through or search stored content from web_search or fetch_content by responseId.",
		promptSnippet: "Use after web_search or fetch_content to read stored content; findText finds passages without paging.",
		parameters: getSearchContentParams,
		execute: async (_id, params) => runGetSearchContent(params),
		renderCall(args, theme) {
			const index = args.queryIndex !== undefined ? `queryIndex=${args.queryIndex}` : args.urlIndex !== undefined ? `urlIndex=${args.urlIndex}` : args.responseId;
			const offset = args.offset !== undefined ? ` @ ${args.offset}` : "";
			const find = args.findText !== undefined ? ` · find ${typeof args.findText === "string" ? 1 : args.findText.length}` : "";
			return new Text(title(theme, "get_content", `${index}${offset}${find}`), 0, 0);
		},
		renderResult: renderResult((details) => {
			if (typeof details.matchCount === "number") return `${details.title} (${details.matchCount} matches, ${details.returnedMatches} shown)`;
			const offset = typeof details.offset === "number" ? details.offset : 0;
			const shown = typeof details.returnedChars === "number" && details.truncated ? `, showing ${offset}-${offset + details.returnedChars}` : "";
			return `${details.title} (${details.contentLength ?? 0} chars${shown})`;
		}),
	});
}
