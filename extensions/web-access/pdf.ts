// PDF to Markdown with unpdf (PDF.js), written to a temp file so the agent can grep the whole document.
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { extractText, getDocumentProxy, getMeta } from "unpdf";

const MAX_PAGES = 100;

export function pdfOutputDir(): string {
	return join(tmpdir(), "pi-web-pdf");
}

export interface PdfMarkdown {
	title: string;
	content: string;
	outputPath: string;
}

export async function pdfToMarkdown(buffer: ArrayBuffer, url: string): Promise<PdfMarkdown> {
	const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
	const { info } = await getMeta(pdf);
	const { totalPages, text } = await extractText(pdf, { mergePages: false });
	const pages = text.slice(0, MAX_PAGES);
	const urlTitle = basename(new URL(url).pathname).replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || "document";
	const title = typeof info.Title === "string" && info.Title.trim() ? info.Title.trim() : urlTitle;
	const header = [`# ${title}`, "", `> Source: ${url}`, `> Pages: ${totalPages}${totalPages > pages.length ? ` (extracted first ${pages.length})` : ""}`];
	if (typeof info.Author === "string" && info.Author.trim()) header.push(`> Author: ${info.Author.trim()}`);
	const body = pages
		.map((page, index) => ({ page: index + 1, text: page.replace(/\s+/g, " ").trim() }))
		.filter((page) => page.text)
		.map((page, index) => (index === 0 ? page.text : `<!-- Page ${page.page} -->\n\n${page.text}`))
		.join("\n\n");
	const content = `${header.join("\n")}\n\n---\n\n${body}`;
	const slug =
		title
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.trim()
			.replace(/[\s-]+/g, "-")
			.slice(0, 100) || "document";
	await mkdir(pdfOutputDir(), { recursive: true });
	const outputPath = join(pdfOutputDir(), `${slug}.md`);
	await writeFile(outputPath, content, "utf8");
	return { title, content, outputPath };
}
