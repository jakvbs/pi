/**
 * A script's result as the model reads it, copied from the coding agent's code mode: a "Script completed/failed"
 * header with the wall time, the script's text items (`==> text N/M <==` when there are several), its `console` lines
 * in one `<console_output>` block, the returned value, and on failure the error with the calls already made. A result
 * past the tool output limit has its text cut to its start and end, with the complete text in a temp file; images are
 * saved to temp files too, with their path next to them, because a script has no other way to hand their bytes on.
 */
import { boundOutput, utf8ByteLength } from "@earendil-works/chord/output";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { CodemodeOutputItem, CodemodeResult } from "@earendil-works/pi-codemode/portable";

type Item = TextContent | ImageContent;
/** A text item, or an image saved to a file with the label that names the file. */
type Saved = TextContent | { readonly image: ImageContent; readonly label: string };

/** Writes a file of the result under a fixed name; its path, or why it could not be written. */
export type OutputFile = (name: string, data: string | Uint8Array) => Promise<{ path: string } | { error: string }>;

/** Bytes per token when estimating, as the Harness counts the tool output limit. */
const BYTES_PER_TOKEN = 4;
/** The cut counts bytes only: the code mode tool declares no line limit. */
const NO_LINE_LIMIT = Number.MAX_SAFE_INTEGER;

/** File extensions of the image types `image()` accepts. */
const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

/** Like the script's `text()`: strings as is, other values as compact JSON. */
function valueText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? String(value);
}

/**
 * Lay out the script's output so the model can tell items apart: with more than one text item, each starts with a
 * `==> text N/M <==` line; `console` lines follow all other output in one `<console_output>` block.
 */
function formatItems(output: readonly CodemodeOutputItem[]): Item[] {
	const total = output.filter((item) => item.type === "text" && !item.console).length;
	const items: Item[] = [];
	const consoleLines: string[] = [];
	let index = 0;
	for (const item of output) {
		if (item.type === "image") items.push(item);
		else if (item.console) consoleLines.push(item.text);
		else {
			index++;
			items.push({ type: "text", text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text });
		}
	}
	if (consoleLines.length > 0) {
		items.push({ type: "text", text: `<console_output>\n${consoleLines.join("\n")}\n</console_output>` });
	}
	return items;
}

/**
 * Join adjacent text items into one, each part starting on its own line. The separator check looks at the last
 * non-empty part, not the joined text: reading the end of a growing concatenation makes V8 copy it on every item, which
 * is quadratic.
 */
function joinAdjacentText(items: readonly Item[]): Item[] {
	const joined: Item[] = [];
	let parts: string[] = [];
	let lastPart = "";
	const flush = () => {
		if (parts.length > 0) joined.push({ type: "text", text: parts.join("") });
		parts = [];
		lastPart = "";
	};
	for (const item of items) {
		if (item.type !== "text") {
			flush();
			joined.push(item);
			continue;
		}
		if (lastPart !== "" && !lastPart.endsWith("\n")) {
			parts.push("\n");
			lastPart = "\n";
		}
		parts.push(item.text);
		if (item.text !== "") lastPart = item.text;
	}
	flush();
	return joined;
}

/**
 * Cut the text to `maxBytes`: the text items become one item that keeps the start and end of the text in whole lines,
 * within `maxBytes` with its notes, and images follow it. The complete text is written to a temp file.
 */
async function truncate(
	items: readonly Saved[],
	maxBytes: number,
	write: OutputFile,
): Promise<{ items: Saved[]; fullOutputPath?: string }> {
	const combined = items
		.filter((item): item is TextContent => !("image" in item))
		.map((item) => item.text)
		.join("\n");
	const bytes = utf8ByteLength(combined);
	const tokens = Math.ceil(bytes / BYTES_PER_TOKEN);
	const warning = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${combined.split("\n").length}\n\n`;
	const spilled = await write("output.txt", combined);
	const notice =
		"path" in spilled
			? `\n\n[Full output: ${spilled.path} (read with offset/limit)]`
			: `\n\n[Could not save the full output: ${spilled.error}]`;
	// The marker counts fewer tokens than the whole text, so its length with the whole count bounds it.
	const notes = utf8ByteLength(`${warning}…${tokens} tokens truncated…${notice}`);
	const budget = Math.max(0, maxBytes - notes);
	const head = boundOutput(combined, { maxBytes: Math.floor(budget / 2), maxLines: NO_LINE_LIMIT, retain: "head" });
	const tail = boundOutput(combined, { maxBytes: budget - head.bytes, maxLines: NO_LINE_LIMIT, retain: "tail" });
	const removed = Math.ceil((bytes - head.bytes - tail.bytes) / BYTES_PER_TOKEN);
	return {
		items: [
			{ type: "text", text: `${warning}${head.text}…${removed} tokens truncated…${tail.text}${notice}` },
			...items.filter((item) => "image" in item),
		],
		...("path" in spilled ? { fullOutputPath: spilled.path } : {}),
	};
}

/** Save each image to a file, once however often it is shown, with a label that names the path. */
async function saveImages(items: readonly Item[], write: OutputFile): Promise<Saved[]> {
	const labels = new Map<string, Promise<string>>();
	const label = async ({ data, mimeType }: ImageContent, index: number): Promise<string> => {
		const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
		const kind = `${mimeType}, ${bytes.length} bytes`;
		// A failed write must not discard the result of a script whose calls already ran: it becomes part of the label.
		const saved = await write(`image-${index}${IMAGE_EXTENSIONS[mimeType] ?? ".bin"}`, bytes);
		return "path" in saved
			? `[Image saved to ${saved.path} (${kind})]`
			: `[Image (${kind}) could not be saved: ${saved.error}]`;
	};
	return Promise.all(
		items.map(async (item): Promise<Saved> => {
			if (item.type === "text") return item;
			let pending = labels.get(item.data);
			if (pending === undefined) {
				pending = label(item, labels.size + 1);
				labels.set(item.data, pending);
			}
			return { image: item, label: await pending };
		}),
	);
}

/** The content of saved items: each image with its label before it, adjacent text joined. */
function content(items: readonly Saved[]): Item[] {
	return joinAdjacentText(
		items.flatMap((item): Item[] => ("image" in item ? [{ type: "text", text: item.label }, item.image] : [item])),
	);
}

/** UTF-8 bytes of the text items, which the Harness bounds joined. */
function textBytes(items: readonly Item[]): number {
	let bytes = 0;
	for (const item of items) if (item.type === "text") bytes += utf8ByteLength(item.text);
	return bytes;
}

function formatError(
	result: Extract<CodemodeResult, { ok: false }>,
	calls: readonly { name: string; status: string }[],
) {
	const { error } = result;
	const head =
		error.kind === "script"
			? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
			: error.kind === "timeout"
				? `Script timed out: ${error.message}`
				: error.kind === "aborted"
					? `Script aborted: ${error.message}`
					: `Script sandbox failed: ${error.message}`;
	const summary =
		calls.length === 0
			? "No tool calls were made."
			: `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
	return `${head}\n\n${summary}`;
}

/**
 * The tool result's content for a script's result, within `maxBytes` of text so the Harness does not cut it again,
 * and the path of the complete text when it was cut.
 */
export async function formatResult(
	result: CodemodeResult,
	options: {
		/** Images `models.generateImages()` returned; when the script showed none, the result says so. */
		readonly generatedImages: number;
		readonly wallMs: number;
		readonly calls: readonly { name: string; status: string }[];
		/** The tool's output limit (`ToolExecutionApi.outputLimits`). */
		readonly maxBytes: number;
		readonly write: OutputFile;
	},
): Promise<{ content: Item[]; fullOutputPath?: string }> {
	const output = [...result.output];
	if (result.ok && result.value !== undefined) output.push({ type: "text", text: valueText(result.value) });
	const items = formatItems(output);
	if (!result.ok) items.push({ type: "text", text: `Script error:\n${formatError(result, options.calls)}` });
	const generated = options.generatedImages;
	if (generated > 0 && !items.some((item) => item.type === "image")) {
		items.push({
			type: "text",
			text: `Note: models.generateImages() returned ${generated} image${generated === 1 ? "" : "s"} that the script did not show. Show each image block of result.output with image(block).`,
		});
	}
	const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${(options.wallMs / 1000).toFixed(1)} seconds\nOutput:\n`;
	const saved = await saveImages(joinAdjacentText(items), options.write);
	const whole = content(saved);
	const maxText = options.maxBytes - utf8ByteLength(header);
	if (textBytes(whole) <= maxText) return { content: [{ type: "text", text: header }, ...whole] };
	// Each label, and the line break that may join it to the text before it, stays next to its image.
	let labelBytes = 0;
	for (const item of saved) if ("image" in item) labelBytes += utf8ByteLength(item.label) + 1;
	const truncated = await truncate(saved, maxText - labelBytes, options.write);
	return {
		content: [{ type: "text", text: header }, ...content(truncated.items)],
		...(truncated.fullOutputPath === undefined ? {} : { fullOutputPath: truncated.fullOutputPath }),
	};
}
