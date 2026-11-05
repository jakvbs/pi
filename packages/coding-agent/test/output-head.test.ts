import { describe, expect, it } from "vitest";
import { cutHead, headOf, OutputHeadCollector } from "../src/core/tools/output-head.ts";
import { truncateHead } from "../src/core/tools/truncate.ts";

/** Seeded generator, so a failing case can be reproduced from its seed. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Newlines, empty lines and runs longer than the budgets, in one- to four-byte characters.
const PARTS = ["\n", "\n", "\n\n", "a", "bc", "é", "€", "😀", "\r\n", "x".repeat(40), "y".repeat(130)];

function randomText(next: () => number): string {
	const parts = Array.from({ length: Math.floor(next() * 60) }, () => PARTS[Math.floor(next() * PARTS.length)]);
	return parts.join("");
}

/** Splits `text` at random places, also inside surrogate pairs' neighbours but never inside a pair. */
function randomPieces(text: string, next: () => number): string[] {
	const characters = Array.from(text);
	const pieces: string[] = [];
	for (let start = 0; start < characters.length; ) {
		const end = start + 1 + Math.floor(next() * 30);
		pieces.push(characters.slice(start, end).join(""));
		start = end;
	}
	return pieces;
}

const wholeCut = (text: string, maxBytes: number) =>
	truncateHead(text, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes });

describe("OutputHeadCollector", () => {
	it("cuts output written in pieces as truncateHead cuts the whole output, at its budget and below", () => {
		for (let seed = 1; seed <= 3000; seed++) {
			const next = random(seed);
			const text = randomText(next);
			const budget = Math.floor(next() * 200);
			const collector = new OutputHeadCollector(budget);
			for (const piece of randomPieces(text, next)) collector.write(piece);
			const head = collector.head();
			for (const maxBytes of [budget, Math.floor(budget / 2), 0]) {
				// JSON keeps key order, which session files serialize.
				expect(JSON.stringify(cutHead(head, maxBytes)), `seed ${seed}, budget ${budget}, cut at ${maxBytes}`).toBe(
					JSON.stringify(wholeCut(text, maxBytes)),
				);
			}
		}
	});

	it("keeps the start of a first line longer than the budget", () => {
		const collector = new OutputHeadCollector(10);
		for (const piece of ["€€€", "€€€", "€€€", "€€€\nnext"]) collector.write(piece);
		expect(collector.head()).toEqual({ text: "€€€€€€\nnext", totalLines: 2, totalBytes: 41 });
	});

	it("keeps the budget and one piece of a long line, and one line after it", () => {
		const collector = new OutputHeadCollector(1000);
		const chunk = `${"z".repeat(9000)}\n${"line\n".repeat(2000)}`;
		for (let i = 0; i < 200; i++) {
			for (let start = 0; start < chunk.length; start += 100) collector.write(chunk.slice(start, start + 100));
		}
		expect(collector.head()).toEqual({
			text: `${"z".repeat(1100)}\nline`,
			totalLines: 200 * 2001,
			totalBytes: 200 * chunk.length,
		});
	});

	it("writes lines with a newline between them, an empty first line included", () => {
		const collector = new OutputHeadCollector(100);
		for (const line of ["", "a", "", "b"]) collector.writeLine(line);
		expect(collector.head()).toEqual(headOf("\na\n\nb", 100));
		expect(collector.head()).toEqual({ text: "\na\n\nb", totalLines: 4, totalBytes: 5 });
	});

	it("counts no lines for empty output and drops a trailing empty line, as truncateHead does", () => {
		expect(headOf("", 10)).toEqual({ text: "", totalLines: 0, totalBytes: 0 });
		expect(headOf("a\nb\n", 10)).toEqual({ text: "a\nb\n", totalLines: 2, totalBytes: 4 });
	});
});
