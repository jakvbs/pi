// Blocks that carry a whole file into model context, and how model context carries their repeats.
import type { JsonValue, Message } from "@earendil-works/pi-ai";

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/** Render a skill block, followed by the user's request when there is one. */
export function formatSkillBlock(block: ParsedSkillBlock): string {
	const skillBlock = `<skill name="${block.name}" location="${block.location}">\n${block.content}\n</skill>`;
	return block.userMessage ? `${skillBlock}\n\n${block.userMessage}` : skillBlock;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/**
 * Tool result `details` that mark the result text as the whole content of the file at `wholeFile.path`. The built-in
 * read tool sets them; a tool from an extension may set them too.
 */
export interface WholeFileDetails {
	wholeFile: { path: string };
}

/**
 * Send each version of a whole file to the model in full once. A block, which is a skill block or a tool result marked
 * with {@link WholeFileDetails}, becomes a short note when the latest earlier full copy from the same source has the
 * same content; every other block stays in full. A changed file, a file whose earlier copy compaction summarized, and a
 * block that does not parse therefore cost a copy and never lose content. The result for a message depends only on the
 * messages before it, so appending messages keeps the prompt-cache prefix.
 */
export function collapseRepeatedContextBlocks(messages: Message[]): Message[] {
	// Source of a block, for example `skill:/path/SKILL.md`, to the content of its latest full copy.
	const latest = new Map<string, string>();
	const isRepeat = (source: string, content: string): boolean => {
		if (latest.get(source) === content) return true;
		latest.set(source, content);
		return false;
	};
	const collapseText = (text: string): string => {
		const block = parseSkillBlock(text);
		if (!block || !isRepeat(`skill:${block.location}`, block.content)) return text;
		return formatSkillBlock({ ...block, content: SKILL_UNCHANGED });
	};
	return messages.map((message) => {
		if (message.role === "toolResult") {
			const path = wholeFilePath(message.details);
			if (path === undefined || message.content.some((part) => part.type !== "text")) return message;
			const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			if (!isRepeat(`file:${path}`, text)) return message;
			return { ...message, content: [{ type: "text" as const, text: fileUnchanged(path) }] };
		}
		if (message.role !== "user") return message;
		if (typeof message.content === "string") {
			const content = collapseText(message.content);
			return content === message.content ? message : { ...message, content };
		}
		const content = message.content.map((part) => {
			if (part.type !== "text") return part;
			const text = collapseText(part.text);
			return text === part.text ? part : { ...part, text };
		});
		return content.every((part, index) => part === message.content[index]) ? message : { ...message, content };
	});
}

/** The path of a {@link WholeFileDetails} mark. Details come from session files and extension tools, so their shape is checked. */
function wholeFilePath(details: JsonValue | undefined): string | undefined {
	if (typeof details !== "object" || details === null || !("wholeFile" in details)) return undefined;
	const wholeFile = details.wholeFile;
	if (typeof wholeFile !== "object" || wholeFile === null || !("path" in wholeFile)) return undefined;
	return typeof wholeFile.path === "string" ? wholeFile.path : undefined;
}

const fileUnchanged = (path: string) =>
	`${path} has not changed since its full content last appeared earlier in this conversation. Use that content.`;

const SKILL_UNCHANGED =
	"This skill is already loaded and has not changed since it was last loaded earlier in this conversation. Follow those instructions.";
