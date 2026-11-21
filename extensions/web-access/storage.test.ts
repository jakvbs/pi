import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cacheDir, ENTRY_TYPE, getResult, restoreFromBranch, storeFetch, storeSearch } from "./storage.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "web-access-storage-"));

function entry(data: unknown): SessionEntry {
	return { type: "custom", customType: ENTRY_TYPE, data, id: "e", parentId: null, timestamp: new Date().toISOString() } as SessionEntry;
}

const page = { url: "https://example.com/a", title: "A", content: "Full text of A", error: null, status: 200 };

test("a search result is kept in memory and its session entry carries the results", () => {
	const queries = [{ query: "q", answer: "ans", results: [{ title: "T", url: "https://t.example", snippet: "" }], error: null, provider: "openai" }];
	const data = storeSearch(queries);
	assert.equal(data.type, "search");
	assert.deepEqual(getResult(data.id), data);
	assert.deepEqual(data.type === "search" && data.queries, queries);
});

test("a fetch result writes its text to the cache file; the session entry holds only metadata and the cache key", () => {
	const data = storeFetch([page]);
	assert.equal(data.type, "fetch");
	assert.ok(data.type === "fetch" && data.fetchCache);
	const key = data.type === "fetch" ? data.fetchCache?.key : undefined;
	assert.equal(key, `${data.id}.json`);
	assert.deepEqual(data.type === "fetch" && data.urlMetadata, [{ url: page.url, title: "A", error: null, contentLength: 14, status: 200, mimeType: undefined }]);
	const file = join(cacheDir(), `${data.id}.json`);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).urls, [page]);
	assert.deepEqual(getResult(data.id), { id: data.id, type: "fetch", timestamp: data.timestamp, urls: [page] });
});

test("cache files older than an hour are deleted when a new fetch is stored", () => {
	mkdirSync(cacheDir(), { recursive: true });
	const old = join(cacheDir(), "old.json");
	writeFileSync(old, "{}");
	const hourAgo = new Date(Date.now() - 61 * 60 * 1000);
	utimesSync(old, hourAgo, hourAgo);
	storeFetch([page]);
	assert.equal(existsSync(old), false);
});

test("the cache keeps at most 128 files, evicting the oldest", () => {
	mkdirSync(cacheDir(), { recursive: true });
	const recent = new Date(Date.now() - 60 * 1000);
	for (let index = 0; index < 130; index++) {
		const file = join(cacheDir(), `fill${index}.json`);
		writeFileSync(file, "{}");
		const time = new Date(recent.getTime() + index);
		utimesSync(file, time, time);
	}
	storeFetch([page]);
	const names = readdirSync(cacheDir());
	assert.equal(names.length, 128);
	assert.equal(names.includes("fill0.json"), false);
	assert.equal(names.includes("fill129.json"), true);
});

test("restoring a branch reads fetch text from the cache, keeps old inline entries, and marks expired or missing text", () => {
	const now = Date.now();
	mkdirSync(cacheDir(), { recursive: true });
	writeFileSync(join(cacheDir(), "cached1.json"), JSON.stringify({ id: "cached1", type: "fetch", timestamp: now, urls: [page] }));
	const metadata = [{ url: page.url, title: "A", error: null, contentLength: 14 }];
	const restored = restoreFromBranch([
		entry({ id: "cached1", type: "fetch", timestamp: now, urlMetadata: metadata, fetchCache: { version: 1, key: "cached1.json", storedAt: now } }),
		entry({ id: "inline1", type: "fetch", timestamp: now, urls: [page] }),
		entry({ id: "old1", type: "fetch", timestamp: now - 2 * 60 * 60 * 1000, urlMetadata: metadata, fetchCache: { version: 1, key: "old1.json", storedAt: now } }),
		entry({ id: "gone1", type: "fetch", timestamp: now, urlMetadata: metadata, fetchCache: { version: 1, key: "gone1.json", storedAt: now } }),
		entry({ id: "evil1", type: "fetch", timestamp: now, urlMetadata: metadata, fetchCache: { version: 1, key: "../../secret.json", storedAt: now } }),
		entry({ id: "search1", type: "search", timestamp: 0, queries: [{ query: "q", answer: "a", results: [{ url: "https://r.example" }], error: null }] }),
		entry({ id: "research1", type: "research", timestamp: now, artifact: {} }),
		entry({ id: "broken", type: "search", timestamp: now, queries: [{ nope: true }] }),
		{ type: "custom", customType: "other", data: {}, id: "x", parentId: null, timestamp: "" } as SessionEntry,
	]);
	assert.equal(restored, 6);
	const urls = (id: string) => {
		const result = getResult(id);
		return result?.type === "fetch" ? result.urls : undefined;
	};
	assert.deepEqual(urls("cached1"), [page]);
	assert.deepEqual(urls("inline1"), [page]);
	for (const id of ["old1", "gone1", "evil1"]) {
		assert.deepEqual(urls(id), [{ url: page.url, title: "A", content: "", error: "Cached fetched content is missing or expired", status: undefined, mimeType: undefined }], id);
	}
	assert.deepEqual(getResult("search1"), { id: "search1", type: "search", timestamp: 0, queries: [{ query: "q", answer: "a", results: [{ url: "https://r.example", title: "https://r.example", snippet: "" }], error: null }] });
	assert.equal(getResult("research1"), undefined);
	assert.equal(getResult("broken"), undefined);
});

test("a result already in memory is not replaced by a restore", () => {
	const data = storeFetch([page]);
	assert.equal(restoreFromBranch([entry({ ...data, urls: [{ ...page, content: "stale" }] })]), 0);
	const result = getResult(data.id);
	assert.equal(result?.type === "fetch" && result.urls[0].content, "Full text of A");
});
