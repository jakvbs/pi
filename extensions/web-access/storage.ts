// Stored search and fetch results, addressed by responseId.
//
// Each result is also appended to the session as a `web-search-results` custom entry, so a resumed
// session can still read it. Search entries carry their results; fetch entries carry only page
// metadata and point at `<agentDir>/web-search-cache/<id>.json`, which holds the page text for an
// hour (at most 128 files and 128 MiB, oldest evicted first). Both entry shapes are the frozen format earlier versions wrote, so old sessions restore.
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FetchedPage } from "./extract.ts";

export const ENTRY_TYPE = "web-search-results";
const TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_FILES = 128;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const EXPIRED = "Cached fetched content is missing or expired";
const CACHE_KEY = /^[A-Za-z0-9_-]+\.json$/;

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface QueryResult {
	query: string;
	answer: string;
	results: SearchResult[];
	error: string | null;
	provider?: string;
}

export type StoredResult =
	| { id: string; type: "search"; timestamp: number; queries: QueryResult[] }
	| { id: string; type: "fetch"; timestamp: number; urls: FetchedPage[] };

interface UrlMetadata {
	url: string;
	title: string;
	error: string | null;
	contentLength: number;
	status?: number;
	mimeType?: string;
}

/** The session entry data of a fetch result. */
interface FetchEntry {
	id: string;
	type: "fetch";
	timestamp: number;
	urlMetadata: UrlMetadata[];
	fetchCache?: { version: 1; key: string; storedAt: number };
	fetchCacheError?: string;
}

export type SessionEntryData = Extract<StoredResult, { type: "search" }> | FetchEntry;

const results = new Map<string, StoredResult>();

export function newId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function cacheDir(): string {
	return join(getAgentDir(), "web-search-cache");
}

function expired(urls: Array<Pick<FetchedPage, "url" | "title" | "status" | "mimeType">>, reason = EXPIRED): FetchedPage[] {
	return urls.map(({ url, title, status, mimeType }) => ({ url, title, content: "", error: reason, status, mimeType }));
}

/** Frees the text of fetch results older than the cache lifetime, in memory and on disk. */
function pruneExpired(now: number): void {
	for (const [id, result] of results) {
		if (result.type === "fetch" && now - result.timestamp >= TTL_MS && result.urls.some((page) => page.content)) {
			results.set(id, { ...result, urls: expired(result.urls) });
		}
	}
	let names: string[];
	try {
		names = readdirSync(cacheDir());
	} catch {
		return;
	}
	const files: Array<{ path: string; mtimeMs: number; size: number }> = [];
	for (const name of names) {
		const path = join(cacheDir(), name);
		const stat = statSync(path, { throwIfNoEntry: false });
		if (!stat?.isFile()) continue;
		if (now - stat.mtimeMs >= TTL_MS) rmSync(path, { force: true });
		else files.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
	}
	// Room for the file about to be written.
	files.sort((a, b) => a.mtimeMs - b.mtimeMs);
	let bytes = files.reduce((total, file) => total + file.size, 0);
	while (files.length >= MAX_CACHE_FILES || (files.length > 0 && bytes > MAX_CACHE_BYTES)) {
		const oldest = files.shift();
		if (!oldest) break;
		bytes -= oldest.size;
		rmSync(oldest.path, { force: true });
	}
}

/** The cache directory, created owner-only; a symlink or non-directory in its place is refused. */
function ensureCacheDir(): string {
	const dir = cacheDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
	return dir;
}

export function storeSearch(queries: QueryResult[]): SessionEntryData {
	const result = { id: newId(), type: "search" as const, timestamp: Date.now(), queries };
	results.set(result.id, result);
	return result;
}

export function storeFetch(urls: FetchedPage[]): SessionEntryData {
	const now = Date.now();
	pruneExpired(now);
	const result = { id: newId(), type: "fetch" as const, timestamp: now, urls };
	results.set(result.id, result);
	const entry: FetchEntry = {
		id: result.id,
		type: "fetch",
		timestamp: now,
		urlMetadata: urls.map(({ url, title, error, content, status, mimeType }) => ({ url, title, error, contentLength: content.length, status, mimeType })),
	};
	try {
		const key = `${result.id}.json`;
		const dir = ensureCacheDir();
		const tmp = join(dir, `${key}.${process.pid}.tmp`);
		writeFileSync(tmp, JSON.stringify(result), { mode: 0o600, flag: "wx" });
		renameSync(tmp, join(dir, key));
		entry.fetchCache = { version: 1, key, storedAt: now };
	} catch (err) {
		entry.fetchCacheError = `Failed to write fetched content cache: ${err instanceof Error ? err.message : String(err)}`;
	}
	return entry;
}

export function getResult(id: string): StoredResult | undefined {
	const result = results.get(id);
	if (result?.type === "fetch" && Date.now() - result.timestamp >= TTL_MS && result.urls.some((page) => page.content)) {
		const stale = { ...result, urls: expired(result.urls) };
		results.set(id, stale);
		return stale;
	}
	return result;
}

// Session entries are read back from disk, so their shape is checked here (a trust boundary).
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPage(value: unknown): FetchedPage | null {
	if (!isRecord(value) || typeof value.url !== "string") return null;
	return {
		url: value.url,
		title: typeof value.title === "string" ? value.title : "",
		content: typeof value.content === "string" ? value.content : "",
		error: typeof value.error === "string" ? value.error : null,
		...(typeof value.status === "number" ? { status: value.status } : {}),
		...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
	};
}

function toQuery(value: unknown): QueryResult | null {
	if (!isRecord(value) || typeof value.query !== "string" || !Array.isArray(value.results)) return null;
	return {
		query: value.query,
		answer: typeof value.answer === "string" ? value.answer : "",
		results: value.results.flatMap((item) =>
			isRecord(item) && typeof item.url === "string"
				? [{ url: item.url, title: typeof item.title === "string" ? item.title : item.url, snippet: typeof item.snippet === "string" ? item.snippet : "" }]
				: [],
		),
		error: typeof value.error === "string" ? value.error : null,
		...(typeof value.provider === "string" ? { provider: value.provider } : {}),
	};
}

function readCachedPages(id: string, key: unknown): FetchedPage[] | null {
	if (typeof key !== "string" || !CACHE_KEY.test(key)) return null;
	try {
		const path = join(cacheDir(), key);
		// Only regular files: a symlink planted in the cache must not make restore read elsewhere.
		if (!lstatSync(cacheDir()).isDirectory() || !lstatSync(path).isFile()) return null;
		const data: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(data) || data.id !== id || !Array.isArray(data.urls)) return null;
		const pages = data.urls.map(toPage);
		return pages.every((page) => page !== null) ? (pages as FetchedPage[]) : null;
	} catch {
		return null;
	}
}

function restoreEntry(data: unknown, now: number): StoredResult | null {
	if (!isRecord(data) || typeof data.id !== "string" || typeof data.timestamp !== "number") return null;
	if (data.type === "search" && Array.isArray(data.queries)) {
		const queries = data.queries.map(toQuery);
		return queries.every((query) => query !== null)
			? { id: data.id, type: "search", timestamp: data.timestamp, queries: queries as QueryResult[] }
			: null;
	}
	if (data.type !== "fetch") return null;
	// Versions before the disk cache stored the pages inline.
	const inline = Array.isArray(data.urls) ? data.urls.map(toPage) : null;
	const metadata = Array.isArray(data.urlMetadata) ? data.urlMetadata.map(toPage) : null;
	const listed = inline ?? metadata;
	if (!listed || listed.some((page) => page === null)) return null;
	const pages = listed as FetchedPage[];
	let urls: FetchedPage[];
	if (now - data.timestamp >= TTL_MS) urls = expired(pages);
	else if (inline) urls = pages;
	else {
		const fetchCache = isRecord(data.fetchCache) ? data.fetchCache : undefined;
		const reason = typeof data.fetchCacheError === "string" ? data.fetchCacheError : EXPIRED;
		urls = readCachedPages(data.id, fetchCache?.key) ?? expired(pages, reason);
	}
	return { id: data.id, type: "fetch", timestamp: data.timestamp, urls };
}

/** Loads the results a session branch recorded. Results already in memory (from this or another live session) are kept. */
export function restoreFromBranch(entries: readonly SessionEntry[]): number {
	const now = Date.now();
	let restored = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const result = restoreEntry(entry.data, now);
		if (!result || results.has(result.id)) continue;
		results.set(result.id, result);
		restored++;
	}
	return restored;
}
