import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fetchPage, htmlToMarkdown } from "./extract.ts";
import type { Lookup } from "./ssrf.ts";

process.env.TMPDIR = mkdtempSync(join(tmpdir(), "web-access-extract-"));

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const lookup: Lookup = async () => [{ address: "93.184.215.14", family: 4 }];
const paragraph = "Readable article text that is long enough for Readability to keep it as the main content. ".repeat(12);
const article = `<html><head><title>Page Title</title></head><body><nav>Menu</nav><article><h1>Heading</h1><p>${paragraph}</p><p>Second <a href="/x">link</a>.</p></article><footer>Footer</footer></body></html>`;

function serve(body: BodyInit, headers: Record<string, string>, status = 200) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = async (input, init) => {
		requests.push({ url: String(input), init });
		return new Response(body, { status, headers });
	};
	return requests;
}

test("htmlToMarkdown keeps the article and drops page chrome", () => {
	const result = htmlToMarkdown(article, new URL("https://example.com/post"));
	assert.equal(result.error, null);
	assert.match(result.content, /Readable article text/);
	assert.match(result.content, /Second \[link\]\(\/x\)\./);
	assert.doesNotMatch(result.content, /Menu|Footer/);
});

test("htmlToMarkdown falls back to the body for short pages and reports script-only pages", () => {
	const short = htmlToMarkdown("<html><head><title>T</title></head><body><nav>Nav</nav><main><p>Short page.</p></main></body></html>", new URL("https://example.com/"));
	assert.equal(short.error, null);
	assert.match(short.content, /Short page\./);
	const app = htmlToMarkdown(`<html><head><title>App</title></head><body>${"<script>1</script>".repeat(5)}</body></html>`, new URL("https://example.com/"));
	assert.equal(app.error, "Page appears to be JavaScript-rendered (content loads dynamically)");
});

test("readable mode asks for Markdown first and converts HTML", async () => {
	const requests = serve(article, { "content-type": "text/html; charset=utf-8" });
	const page = await fetchPage("https://example.com/post", "readable", undefined, lookup);
	assert.equal(page.error, null);
	assert.equal(page.status, 200);
	assert.match(page.content, /Readable article text/);
	const headers = new Headers(requests[0].init?.headers);
	assert.match(headers.get("accept") ?? "", /^text\/markdown/);
	assert.equal(headers.get("user-agent"), "OpenAI File Downloader, XaiImageApiFetch/1.0");
});

test("Markdown and plain text responses are returned as they are, titled by their first heading", async () => {
	serve("# Docs Title\n\nBody.", { "content-type": "text/markdown" });
	const page = await fetchPage("https://example.com/docs", "readable", undefined, lookup);
	assert.deepEqual([page.title, page.content], ["Docs Title", "# Docs Title\n\nBody."]);
});

test("raw mode returns the exact body and refuses non-text types", async () => {
	serve(article, { "content-type": "text/html" });
	const raw = await fetchPage("https://example.com/post", "raw", undefined, lookup);
	assert.equal(raw.content, article);
	assert.equal(raw.mimeType, "text/html");
	serve(new Uint8Array([1, 2, 3]), { "content-type": "application/octet-stream" });
	assert.equal((await fetchPage("https://example.com/bin", "raw", undefined, lookup)).error, "Unsupported content type in raw mode: application/octet-stream");
});

test("HTTP errors, binary types, Cloudflare challenges and oversized bodies are reported", async () => {
	globalThis.fetch = async () => new Response("nope", { status: 404, statusText: "Not Found", headers: { "content-type": "text/html" } });
	assert.deepEqual(await fetchPage("https://example.com/missing", "readable", undefined, lookup), { url: "https://example.com/missing", title: "", content: "", error: "HTTP 404: Not Found", status: 404 });
	serve(new Uint8Array([1]), { "content-type": "image/png" });
	assert.equal((await fetchPage("https://example.com/a.png", "readable", undefined, lookup)).error, "Unsupported content type: image/png");
	serve("<html><head><title>Just a moment...</title></head><body></body></html>", { "content-type": "text/html" });
	assert.match((await fetchPage("https://example.com/", "readable", undefined, lookup)).error ?? "", /Blocked by Cloudflare challenge page/);
	serve("x".repeat(5 * 1024 * 1024 + 1), { "content-type": "text/plain" });
	assert.match((await fetchPage("https://example.com/big.txt", "readable", undefined, lookup)).error ?? "", /Response too large/);
});

test("PDF responses go to the PDF extractor, whose failures are reported", async () => {
	serve("not really a pdf", { "content-type": "application/pdf" });
	const page = await fetchPage("https://example.com/paper", "readable", undefined, lookup);
	assert.ok(page.error);
	assert.doesNotMatch(page.error, /Unsupported content type/);
});

test("internal targets and invalid URLs fail without a request", async () => {
	const requests = serve("secret", { "content-type": "text/plain" });
	assert.match((await fetchPage("http://127.0.0.1:9000/", "readable")).error ?? "", /Blocked internal address/);
	assert.match((await fetchPage("http://169.254.169.254/latest/meta-data", "raw")).error ?? "", /Blocked internal address/);
	assert.equal((await fetchPage("not a url", "readable")).error, "Invalid URL: not a url");
	assert.equal(requests.length, 0);
});

test("an aborted fetch reports Aborted", async () => {
	globalThis.fetch = async (_input, init) => {
		init?.signal?.throwIfAborted();
		await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
		return new Response("late");
	};
	const controller = new AbortController();
	const pending = fetchPage("https://example.com/slow", "readable", controller.signal, lookup);
	controller.abort();
	assert.equal((await pending).error, "Aborted");
});
