import { open } from "node:fs/promises";
import { createOutputFileStream, type OutputFileResult, type OutputFileStream } from "../../utils/output-files.ts";
import { type OutputHead, OutputHeadCollector } from "./output-head.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	/** Set once the full output goes to a file. While output streams in, `saved` means the file is being written. */
	fullOutputFile?: OutputFileResult;
}

export interface FullOutput {
	content: string;
	/** Whether `content` omits part of the output. */
	truncated: boolean;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots and the start the byte limit can show, and opens a
 * temp file when the full output needs to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();
	/** The start of the decoded output, and its line and byte counts. */
	private readonly start: OutputHeadCollector;

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private finished = false;

	private tempFile: OutputFileStream | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
		this.start = new OutputHeadCollector(this.maxBytes);
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFile || this.shouldUseTempFile()) {
			this.ensureTempFile().write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	/**
	 * Ends the output. The returned snapshot's `fullOutputFile`, when `saved`, names a file that already
	 * holds the whole output. Never rejects: a file that could not be written is `failed`.
	 */
	async close(): Promise<OutputSnapshot> {
		// Opens the file for output the snapshot truncates.
		this.finish();
		// The file's result is only final after closing: a write can still fail while the file flushes.
		await this.tempFile?.close();
		return this.snapshot();
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getRetainedText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const { totalLines, totalBytes } = this.start;
		const truncated = totalLines > this.maxLines || totalBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (totalBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines,
			totalBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return { content: truncation.content, truncation, fullOutputFile: this.tempFile?.result };
	}

	private finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	/**
	 * The complete output, for callers that can take more than the display snapshot. Call after
	 * `close()`. Output longer than `maxBytes` raw bytes keeps its first and
	 * last `maxBytes / 2` bytes around an omission marker. When the temp file could not be saved, only
	 * the retained tail is left: up to its last `maxBytes` bytes, behind the same marker when output is
	 * missing.
	 */
	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		const fullOutputFile = this.tempFile?.result;
		if (!fullOutputFile) {
			return { content: new TextDecoder().decode(Buffer.concat(this.rawChunks)), truncated: false };
		}
		if (fullOutputFile.kind === "failed") {
			return this.readRetainedOutput(maxBytes);
		}
		const file = await open(fullOutputFile.path, "r");
		try {
			const size = (await file.stat()).size;
			if (size <= maxBytes) {
				return { content: new TextDecoder().decode(await file.readFile()), truncated: false };
			}
			const headBytes = Math.floor(maxBytes / 2);
			const tailBytes = maxBytes - headBytes;
			const head = Buffer.alloc(headBytes);
			const tail = Buffer.alloc(tailBytes);
			await file.read(head, 0, headBytes, 0);
			await file.read(tail, 0, tailBytes, size - tailBytes);
			// Cut at character boundaries: streaming decode holds back an incomplete trailing sequence,
			// and the tail skips leading continuation bytes.
			const headText = new TextDecoder().decode(head, { stream: true });
			let tailStart = 0;
			while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
			const tailText = new TextDecoder().decode(tail.subarray(tailStart));
			const omitted = size - headBytes - tailBytes;
			return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
		} finally {
			await file.close();
		}
	}

	/** The start of the output that `maxBytes` can show, and its size. Complete after `close()`. */
	head(): OutputHead {
		return this.start.head();
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		this.start.write(text);
		this.tailText += text;
		this.tailBytes += byteLength(text);
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	/**
	 * The retained tail, for display and as the fallback of `readFullOutput()`. Clipping drops the partial
	 * first line of the tail. When the tail is only the end of one over-long line (plus blank lines),
	 * nothing is left, so it keeps the end of that line instead.
	 */
	private getRetainedText(): string {
		const clippedText = this.getSnapshotText();
		return clippedText.trim().length === 0 ? this.tailText : clippedText;
	}

	/** The retained tail within `maxBytes`, marked as truncated only when output is missing. */
	private readRetainedOutput(maxBytes: number): FullOutput {
		let bytes = Buffer.from(this.getRetainedText(), "utf-8");
		if (bytes.length > maxBytes) {
			let start = bytes.length - maxBytes;
			while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
			bytes = bytes.subarray(start);
		}
		const tail = bytes.toString("utf-8");
		const omitted = this.start.totalBytes - bytes.length;
		if (omitted === 0) {
			return { content: tail, truncated: false };
		}
		return { content: `[... ${omitted} bytes omitted ...]\n\n${tail}`, truncated: true };
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes ||
			this.start.totalBytes > this.maxBytes ||
			this.start.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): OutputFileStream {
		if (this.tempFile) {
			return this.tempFile;
		}
		const tempFile = createOutputFileStream(this.tempFilePrefix, ".log");
		this.tempFile = tempFile;
		for (const chunk of this.rawChunks) {
			tempFile.write(chunk);
		}
		this.rawChunks = [];
		return tempFile;
	}
}
