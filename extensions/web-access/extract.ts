// Fetches one URL as text: readable Markdown from HTML (Readability + Turndown), the exact body in
// raw mode, PDF text, or a GitHub repository view.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { fetchGitHub } from "./github.ts";
import { pdfToMarkdown } from "./pdf.ts";
import { guardedFetch, type Lookup } from "./ssrf.ts";

export type FetchMode = "readable" | "raw" | "answer";

/** One fetched URL, also the shape stored for get_search_content. */
export interface FetchedPage {
	url: string;
	title: string;
	content: string;
	error: string | null;
	status?: number;
	mimeType?: string;
}

const TIMEOUT_MS = 30_000;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MIN_USEFUL_CHARS = 500;
// Sites that block generic bots tend to allow AI fetchers that identify themselves.
const USER_AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0";
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
// Servers with Markdown content negotiation (Cloudflare, Mintlify, Vercel) answer with Markdown directly.
const MARKDOWN_ACCEPT = "text/markdown,text/html;q=0.9,application/xhtml+xml;q=0.9,application/xml;q=0.8,*/*;q=0.7";
const TEXT_TYPES = /^(text\/|application\/(json|ld\+json|xml|xhtml\+xml|javascript|x-javascript)$|application\/.+\+(json|xml)$)/;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function failure(url: string, error: string, extra: Partial<FetchedPage> = {}): FetchedPage {
	return { url, title: "", content: "", error, ...extra };
}

/** The message with its cause: Node's fetch reports every network failure as "fetch failed". */
function errorMessage(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
		total += chunk.value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`Response too large (over ${Math.round(maxBytes / 1024 / 1024)}MB)`);
		}
		chunks.push(chunk.value);
	}
	return Buffer.concat(chunks);
}

function decode(bytes: Uint8Array, contentType: string): string {
	const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
	try {
		return new TextDecoder(charset || "utf-8").decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

function textTitle(text: string, url: URL): string {
	return text.match(/^#{1,2}\s+(.+)/m)?.[1]?.replace(/\*+/g, "").trim() || url.pathname.split("/").pop() || url.href;
}

/** Drops inline base64 payloads (data: images) that would flood the result with opaque text. */
function stripDataUris(markdown: string): string {
	return markdown.replace(/data:[a-z]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]{200,}/gi, "data:(omitted)");
}

/** Readable Markdown of an HTML page: Readability's article, else the page body without chrome. */
export function htmlToMarkdown(html: string, url: URL): { title: string; content: string; error: string | null } {
	const { document } = parseHTML(html);
	const pageTitle = document.title?.trim() ?? "";
	// Readability mutates the document it reads, so the fallback parses the page again.
	const article = new Readability(document as unknown as Document).parse();
	const articleMarkdown = article?.content ? turndown.turndown(article.content).trim() : "";
	if (articleMarkdown.length >= MIN_USEFUL_CHARS) {
		return { title: article?.title?.trim() || pageTitle, content: articleMarkdown, error: null };
	}
	const { document: page } = parseHTML(html);
	for (const node of page.querySelectorAll("script, style, noscript, template, nav, header, footer, aside, svg")) node.remove();
	const bodyMarkdown = page.body ? turndown.turndown(page.body.innerHTML).trim() : "";
	const content = bodyMarkdown.length > articleMarkdown.length ? bodyMarkdown : articleMarkdown;
	if (content.length > 0) return { title: article?.title?.trim() || pageTitle, content, error: null };
	const scripts = (html.match(/<script\b/gi) ?? []).length;
	return {
		title: pageTitle,
		content: "",
		error:
			scripts > 3
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: `Could not extract readable content from ${url.href}`,
	};
}

async function fetchHttp(url: URL, mode: FetchMode, signal: AbortSignal, lookup?: Lookup): Promise<FetchedPage> {
	const { response, url: finalUrl } = await guardedFetch(
		url,
		{
			signal,
			headers: {
				"User-Agent": USER_AGENT,
				Accept: mode === "raw" ? BROWSER_ACCEPT : MARKDOWN_ACCEPT,
				"Accept-Language": "en-US,en;q=0.9",
			},
		},
		lookup,
	);
	const status = response.status;
	const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
	const mimeType = contentType.split(";")[0].trim();
	if (!response.ok) {
		await response.body?.cancel();
		return failure(url.href, `HTTP ${status}${response.statusText ? `: ${response.statusText}` : ""}`, { status });
	}
	const isPdf = mimeType === "application/pdf" || finalUrl.pathname.toLowerCase().endsWith(".pdf");
	if (mode === "raw") {
		if (!TEXT_TYPES.test(mimeType)) {
			await response.body?.cancel();
			return failure(url.href, `Unsupported content type in raw mode: ${mimeType || "missing"}${isPdf ? '; retry without mode for Markdown' : ""}`, { status, mimeType });
		}
		const text = decode(await readLimited(response, MAX_TEXT_BYTES), contentType);
		return { url: url.href, title: textTitle(text, finalUrl), content: text, error: null, status, mimeType };
	}
	if (isPdf) {
		const bytes = await readLimited(response, MAX_PDF_BYTES);
		const pdf = await pdfToMarkdown(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, finalUrl.href);
		// Answer mode hands the text to a model; the saved file only helps the agent.
		const content = mode === "answer" ? pdf.content : `PDF extracted and saved to: ${pdf.outputPath}\n\n${pdf.content}`;
		return { url: url.href, title: pdf.title, content, error: null, status };
	}
	if (mimeType && !TEXT_TYPES.test(mimeType)) {
		await response.body?.cancel();
		return failure(url.href, `Unsupported content type: ${mimeType}`, { status, mimeType });
	}
	const text = decode(await readLimited(response, MAX_TEXT_BYTES), contentType);
	const isHtml = mimeType === "text/html" || mimeType === "application/xhtml+xml";
	if (!isHtml) return { url: url.href, title: textTitle(text, finalUrl), content: text, error: null, status };
	if (response.headers.get("cf-mitigated") === "challenge" || /<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(text)) {
		return failure(url.href, `HTTP ${status}: Blocked by Cloudflare challenge page`, { status });
	}
	const readable = htmlToMarkdown(text, finalUrl);
	return { url: url.href, title: readable.title, content: stripDataUris(readable.content), error: readable.error, status };
}

/** Fetches `rawUrl` in `mode`. Never throws: failures come back in `error`. */
export async function fetchPage(rawUrl: string, mode: FetchMode, signal?: AbortSignal, lookup?: Lookup): Promise<FetchedPage> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return failure(rawUrl, `Invalid URL: ${rawUrl}`);
	}
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	try {
		if (mode !== "raw") {
			const github = await fetchGitHub(url, signal);
			if (github) return { url: rawUrl, ...github, error: null };
		}
		return await fetchHttp(url, mode, combined, lookup);
	} catch (err) {
		if (signal?.aborted) return failure(rawUrl, "Aborted");
		if (timeout.aborted) return failure(rawUrl, `Timed out after ${TIMEOUT_MS / 1000}s`);
		return failure(rawUrl, errorMessage(err));
	}
}
