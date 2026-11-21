import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pdfOutputDir, pdfToMarkdown } from "./pdf.ts";

process.env.TMPDIR = mkdtempSync(join(tmpdir(), "web-access-pdf-"));

/** A real one-page PDF with `text` in Helvetica. */
function makePdf(text: string): ArrayBuffer {
	const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
	];
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(body.length);
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(body).buffer as ArrayBuffer;
}

test("a PDF becomes Markdown with its source and page count, saved under the PDF output directory", async () => {
	const result = await pdfToMarkdown(makePdf("Hello from the PDF fixture"), "https://example.com/papers/my_paper-v2.pdf");
	assert.equal(result.title, "my paper v2");
	assert.match(result.content, /^# my paper v2\n\n> Source: https:\/\/example.com\/papers\/my_paper-v2.pdf\n> Pages: 1\n\n---\n\nHello from the PDF fixture$/);
	assert.equal(result.outputPath, join(pdfOutputDir(), "my-paper-v2.md"));
	assert.equal(readFileSync(result.outputPath, "utf8"), result.content);
});

test("an unreadable PDF rejects", async () => {
	await assert.rejects(pdfToMarkdown(new TextEncoder().encode("not a pdf").buffer as ArrayBuffer, "https://example.com/x.pdf"));
});
