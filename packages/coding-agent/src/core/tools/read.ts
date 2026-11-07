import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from "@earendil-works/pi-ai";
import { constants } from "fs";
import { access as fsAccess, open as fsOpen, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { TextDecoder } from "util";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { WholeFileDetails } from "../context-blocks.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { headOf, type OutputHead, OutputHeadCollector } from "./output-head.ts";
import { DEFAULT_TOOL_OUTPUT_MAX_TOKENS, limitOutput, toolOutputMaxBytes } from "./output-limit.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { readRenderers } from "./renderers/read.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";
import type { TruncationResult } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

/**
 * Result for programmatic callers such as codemode scripts: the text for text files, and an image
 * block for images that codemode's `image()` accepts. `note` is the text that goes with the image,
 * such as resize hints. Property descriptions are left out so the type stays on one line in tool
 * descriptions.
 */
const readOutputSchema = Type.Union([
	Type.String(),
	Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String(), note: Type.String() }),
]);

export type ReadToolOutput = Static<typeof readOutputSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
	/** Set when the result text is the whole file, so model context can refer to an unchanged repeat. */
	wholeFile?: WholeFileDetails["wholeFile"];
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
	/**
	 * Stream file contents in chunks. When present, text files are read through it and only the lines
	 * that will be shown are kept in memory; otherwise readFile loads the whole file. Stop reading when
	 * the signal aborts; the read tool also stops consuming the stream then.
	 */
	createReadStream?: (absolutePath: string, options: { signal?: AbortSignal }) => AsyncIterable<Uint8Array>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	createReadStream: readLocalFileChunks,
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

/**
 * Stream a local file the way fs.readFile reads it: a regular file up to its size when opened, so text
 * appended during the read is not counted and a growing file still ends; a file reporting size 0 (such
 * as /proc files) and other file types until EOF.
 */
async function* readLocalFileChunks(path: string, { signal }: { signal?: AbortSignal }): AsyncIterable<Uint8Array> {
	const handle = await fsOpen(path, "r");
	try {
		const stats = await handle.stat();
		const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined;
		yield* handle.createReadStream({ end, signal, autoClose: false });
	} finally {
		await handle.close();
	}
}

export interface ReadToolOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
	/** Fallback resize profile when the execution context has no model metadata. */
	resizeOptions?: ModelImageResizeOptions;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
	/** Estimated tokens of file text one call returns. Default: the `toolOutputMaxTokens` default. */
	maxOutputTokens?: number;
}

/** The image block and its note, or the text for text files and images that could not be processed. */
function toReadOutput(content: (TextContent | ImageContent)[]): ReadToolOutput {
	const text = content.find((block) => block.type === "text")?.text ?? "";
	const image = content.find((block) => block.type === "image");
	return image ? { type: "image", data: image.data, mimeType: image.mimeType, note: text } : text;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

/** The lines a read selects, with the file's line count; line counts follow `text.split("\n")`. */
interface SelectedLines {
	totalFileLines: number;
	selected: OutputHead;
}

/**
 * Whether a range can be streamed. Other values (fractional, negative limit) keep the whole-file path,
 * whose array slicing defines what they select, for example limit -1 as all lines but the last.
 */
function isStreamableRange(offset: number | undefined, limit: number | undefined): boolean {
	return (
		(offset === undefined || Number.isInteger(offset)) &&
		(limit === undefined || (Number.isInteger(limit) && limit >= 0))
	);
}

/** Select lines from a whole file in memory: for operations without createReadStream and unusual ranges. */
function selectLinesFromBuffer(
	buffer: Buffer,
	startLine: number,
	limit: number | undefined,
	maxBytes: number,
): SelectedLines {
	const allLines = buffer.toString("utf-8").split("\n");
	const endLine = limit === undefined ? undefined : Math.min(startLine + limit, allLines.length);
	return {
		totalFileLines: allLines.length,
		selected: headOf(allLines.slice(startLine, endLine).join("\n"), maxBytes),
	};
}

/**
 * Select lines from a file read in chunks, collecting what `maxBytes` can show of them, so memory does
 * not grow with the file. Stops reading when the signal aborts.
 */
async function selectLinesFromStream(
	chunks: AsyncIterable<Uint8Array>,
	startLine: number,
	limit: number | undefined,
	maxBytes: number,
	signal: AbortSignal | undefined,
): Promise<SelectedLines> {
	const endLine = limit === undefined ? Number.POSITIVE_INFINITY : startLine + limit;
	// Non-fatal UTF-8 that keeps a byte order mark decodes like Buffer.toString("utf-8").
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	const selected = new OutputHeadCollector(maxBytes);
	let line = 0;
	// The selected lines are one span of each piece: from the start of the first, or of the piece, to the
	// newline after the last, which is not part of them, or to the end of the piece.
	const select = (text: string) => {
		let selectionStart = line >= startLine && line < endLine ? 0 : -1;
		for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", newline + 1)) {
			line++;
			if (line === startLine && line < endLine) selectionStart = newline + 1;
			else if (line === endLine && selectionStart !== -1) {
				selected.write(text.slice(selectionStart, newline));
				selectionStart = -1;
			}
		}
		if (selectionStart !== -1) selected.write(text.slice(selectionStart));
	};

	for await (const chunk of chunks) {
		// Leaving the loop closes the stream.
		if (signal?.aborted) throw new Error("Operation aborted");
		select(decoder.decode(chunk, { stream: true }));
	}
	select(decoder.decode());
	return { totalFileLines: line + 1, selected: selected.head() };
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const fallbackResizeOptions = options?.resizeOptions;
	const ops = options?.operations ?? defaultReadOperations;
	const maxBytes = toolOutputMaxBytes(options?.maxOutputTokens ?? DEFAULT_TOOL_OUTPUT_MAX_TOKENS);
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${maxBytes / 1024}KB. Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		outputSchema: readOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
							if (aborted) return;
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const processed = await processImage(buffer, mimeType, {
									autoResizeImages,
									resizeOptions: ctx?.model?.inputLimits?.images?.resize ?? fallbackResizeOptions,
								});
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Read text content. Convert offset from 1-indexed input to 0-indexed line access.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								const { totalFileLines, selected } =
									ops.createReadStream && isStreamableRange(offset, limit)
										? await selectLinesFromStream(
												ops.createReadStream(absolutePath, { signal }),
												startLine,
												limit,
												maxBytes,
												signal,
											)
										: selectLinesFromBuffer(await ops.readFile(absolutePath), startLine, limit, maxBytes);
								if (aborted) return;
								// Check if offset is out of bounds.
								if (startLine >= totalFileLines) {
									throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
								}
								// A user-specified limit is honored first. Otherwise the output limit decides.
								const userLimitedLines =
									limit === undefined ? undefined : Math.min(startLine + limit, totalFileLines) - startLine;
								// A user-specified limit that stopped early says where the rest of the file starts.
								const nextOffset = startLine + (userLimitedLines ?? 0) + 1;
								const moreLines =
									userLimitedLines !== undefined && nextOffset <= totalFileLines
										? `\n\n[${totalFileLines - nextOffset + 1} more lines in file. Use offset=${nextOffset} to continue.]`
										: "";
								const limited = limitOutput(selected, maxBytes - Buffer.byteLength(moreLines, "utf-8"), {
									path: absolutePath,
									firstLine: startLineDisplay,
									totalLines: totalFileLines,
								});
								const outputText = limited.truncation.truncated ? limited.text : limited.text + moreLines;
								if (limited.truncation.truncated) details = { truncation: limited.truncation };
								else if (startLine === 0 && moreLines === "") details = { wholeFile: { path: absolutePath } };
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			).then((result) => ({ ...result, structuredContent: toReadOutput(result.content) }));
		},
		...readRenderers,
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): TypeBoxAgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
