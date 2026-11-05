/**
 * The one limit on tool output the model sees: the `toolOutputMaxTokens` setting. Longer output
 * keeps its start, and a notice names the file with the whole output and the line to continue from,
 * so the model can read or grep the rest on demand. The session limits every tool result. Tools
 * that can name a better file, such as `read` naming the file it read, limit their output
 * themselves, notice included, so the session leaves it as it is.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { writeOutputFile } from "../../utils/output-files.ts";
import { formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

/** Default of the `toolOutputMaxTokens` setting. */
export const DEFAULT_TOOL_OUTPUT_MAX_TOKENS = 5000;

/** The same estimate as compaction's token count, in bytes so ASCII output gets exactly the budget. */
const BYTES_PER_TOKEN = 4;

/** Room a tool leaves in the budget for the notices it appends after its limited output. */
export const OUTPUT_NOTICE_RESERVE_BYTES = 400;

/** The byte budget for `maxTokens` estimated tokens. */
export function toolOutputMaxBytes(maxTokens: number): number {
	return maxTokens * BYTES_PER_TOKEN;
}

/** The file that holds the whole output, and where the limited text starts in it. */
export interface OutputLocation {
	path: string;
	/** Line of `path` the text starts at, 1-indexed. */
	firstLine: number;
	/** Lines of `path` in total. */
	totalLines: number;
}

/** Output limited to a byte budget. */
export interface LimitedOutput {
	text: string;
	/** How the start of the output was cut, before the notice was added. */
	truncation: TruncationResult;
}

/**
 * `text` when it fits in `maxBytes`. Otherwise its start and a notice saying which lines of
 * `location` it shows and where to continue, together within `maxBytes`.
 */
export function limitOutput(text: string, maxBytes: number, location: OutputLocation): LimitedOutput {
	const { head, notice, truncation } = splitOutput(text, maxBytes, location);
	if (notice === undefined) return { text, truncation };
	return { text: head ? `${head}\n\n${notice}` : notice, truncation };
}

/** Lines are not limited, only bytes. A finite number, because truncation results are saved as JSON. */
const NO_LINE_LIMIT = Number.MAX_SAFE_INTEGER;

/** The start of `text` that {@link limitOutput} keeps, a prefix of `text`, and the notice when it cuts. */
function splitOutput(
	text: string,
	maxBytes: number,
	location: OutputLocation,
): { head: string; notice?: string; truncation: TruncationResult } {
	const whole = truncateHead(text, { maxLines: NO_LINE_LIMIT, maxBytes });
	if (!whole.truncated) return { head: text, truncation: whole };
	const lastPossibleLine = location.firstLine + location.totalLines - 1;
	const longestNotice = Math.max(
		...[true, false].map((partialLine) =>
			Buffer.byteLength(formatNotice(location, { lastLine: lastPossibleLine, partialLine }, maxBytes), "utf-8"),
		),
	);
	const truncation = truncateHead(text, {
		maxLines: NO_LINE_LIMIT,
		maxBytes: Math.max(0, maxBytes - longestNotice - "\n\n".length),
	});
	const head = truncation.firstLineExceedsLimit
		? // Streaming decode drops an incomplete trailing character instead of emitting a replacement.
			new TextDecoder().decode(Buffer.from(text, "utf-8").subarray(0, truncation.maxBytes), { stream: true })
		: truncation.content;
	const notice = formatNotice(
		location,
		{
			lastLine: location.firstLine + Math.max(truncation.outputLines, 1) - 1,
			partialLine: truncation.firstLineExceedsLimit,
		},
		maxBytes,
	);
	return { head, notice, truncation };
}

function formatNotice(
	{ path, firstLine, totalLines }: OutputLocation,
	{ lastLine, partialLine }: { lastLine: number; partialLine: boolean },
	maxBytes: number,
): string {
	const limit = `${formatSize(maxBytes)} output limit`;
	if (partialLine) {
		return `[Line ${firstLine} alone exceeds the ${limit}; showing its start. Full output: ${path}. Search it with grep, or cut the line with bash.]`;
	}
	return `[Showing lines ${firstLine}-${lastLine} of ${totalLines} (${limit}). Full output: ${path}. Use read with offset=${lastLine + 1} to continue, or search it with grep.]`;
}

/**
 * `content` with its text within `maxBytes`. The text blocks are measured joined with newlines, as
 * providers join them. When they are longer, they are saved joined to an output file, the blocks are
 * cut where the limit falls, later text blocks are dropped, and the notice follows the last text
 * kept. Images stay where they are. Returns `content` itself when the text fits.
 */
export async function limitToolResultText(
	content: (TextContent | ImageContent)[],
	maxBytes: number,
): Promise<(TextContent | ImageContent)[]> {
	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	if (Buffer.byteLength(text, "utf-8") <= maxBytes) return content;
	const path = await writeOutputFile("pi-tool-output", ".txt", text);
	const totalLines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	const { head, notice } = splitOutput(text, maxBytes, { path, firstLine: 1, totalLines });
	const limited: (TextContent | ImageContent)[] = [];
	let lastText: TextContent | undefined;
	// Offset of the block in `text`; `head` is a prefix of `text`.
	let start = 0;
	for (const block of content) {
		if (block.type === "image") {
			limited.push(block);
			continue;
		}
		if (start < head.length) {
			lastText = { type: "text", text: block.text.slice(0, head.length - start) };
			limited.push(lastText);
		}
		start += block.text.length + "\n".length;
	}
	if (lastText) lastText.text += `\n\n${notice}`;
	else limited.unshift({ type: "text", text: notice ?? "" });
	return limited;
}
