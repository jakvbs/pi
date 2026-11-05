/**
 * The start of a tool's output that its byte budget can show, collected while the output is still
 * being read. Tools write the output in pieces as it arrives (file chunks, command output, search
 * results); the collector keeps only what cutting at the budget can show and counts the rest, so
 * memory does not grow with the output. Cutting the collected start gives the same result as cutting
 * the whole output with truncateHead.
 */

import { type TruncationResult, truncateHead } from "./truncate.ts";

/** Lines are not limited, only bytes. A finite number, because truncation results are saved as JSON. */
const NO_LINE_LIMIT = Number.MAX_SAFE_INTEGER;

/** The start of an output and the size of all of it. */
export interface OutputHead {
	/**
	 * The whole output when it fits the collector's budget. Otherwise its lines up to one past the budget,
	 * each cut after the budget's length, which is all that cutting at that budget or a smaller one reads.
	 */
	text: string;
	/** Lines of the whole output, counted as truncateHead counts them. */
	totalLines: number;
	/** UTF-8 bytes of the whole output. */
	totalBytes: number;
}

/** Collects the {@link OutputHead} of output written in pieces, keeping about three times `maxBytes`. */
export class OutputHeadCollector {
	private readonly maxBytes: number;
	private readonly storedLines: string[] = [];
	private storedBytes = 0;
	/** Pieces of the line being written while lines are stored; undefined after the last stored line. */
	private pieces: string[] | undefined = [];
	private lineBytes = 0;
	private bytes = 0;
	private newlines = 0;
	private endsWithNewline = false;
	private linesWritten = false;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	/** Lines written so far, counted as truncateHead counts them. */
	get totalLines(): number {
		return this.bytes === 0 ? 0 : this.newlines + (this.endsWithNewline ? 0 : 1);
	}

	/** UTF-8 bytes written so far. */
	get totalBytes(): number {
		return this.bytes;
	}

	/** Appends `text`; a line may continue across calls. */
	write(text: string): void {
		if (text.length === 0) return;
		this.bytes += Buffer.byteLength(text, "utf-8");
		this.endsWithNewline = text.endsWith("\n");
		let start = 0;
		let newline = text.indexOf("\n");
		for (; this.pieces && newline !== -1; newline = text.indexOf("\n", start)) {
			this.newlines++;
			this.appendToLine(text, start, newline);
			this.finishLine();
			start = newline + 1;
		}
		// After the last stored line, lines are only counted.
		for (; newline !== -1; newline = text.indexOf("\n", newline + 1)) this.newlines++;
		this.appendToLine(text, start, text.length);
	}

	/** Appends `line` as the next line of output written line by line. */
	writeLine(line: string): void {
		this.write(this.linesWritten ? `\n${line}` : line);
		this.linesWritten = true;
	}

	/** The output written so far. */
	head(): OutputHead {
		const lines = this.pieces ? [...this.storedLines, this.pieces.join("")] : this.storedLines;
		return { text: lines.join("\n"), totalLines: this.totalLines, totalBytes: this.bytes };
	}

	private appendToLine(text: string, start: number, end: number): void {
		// A line longer than the budget is never shown whole, and only its start when it is the first line.
		if (!this.pieces || start === end || this.lineBytes > this.maxBytes) return;
		const piece = text.slice(start, end);
		this.pieces.push(piece);
		this.lineBytes += Buffer.byteLength(piece, "utf-8");
	}

	private finishLine(): void {
		if (!this.pieces) return;
		// The line after the one that passes the budget is kept too: truncateHead drops a trailing empty
		// line, so an empty line that passes the budget is only cut as in the whole output when one follows.
		const pastBudget = this.storedBytes > this.maxBytes;
		const line = this.pieces.join("");
		this.storedBytes += Buffer.byteLength(line, "utf-8") + (this.storedLines.length > 0 ? 1 : 0);
		this.storedLines.push(line);
		this.pieces = pastBudget ? undefined : [];
		this.lineBytes = 0;
	}
}

/** The {@link OutputHead} of a whole text, for output that arrives in one piece. */
export function headOf(text: string, maxBytes: number): OutputHead {
	const collector = new OutputHeadCollector(maxBytes);
	collector.write(text);
	return collector.head();
}

/**
 * What truncateHead keeps of the whole output within `maxBytes`, without a line limit. `maxBytes` must
 * not exceed the budget the head was collected for.
 */
export function cutHead(head: OutputHead, maxBytes: number): TruncationResult {
	return {
		...truncateHead(head.text, { maxLines: NO_LINE_LIMIT, maxBytes }),
		totalLines: head.totalLines,
		totalBytes: head.totalBytes,
	};
}
