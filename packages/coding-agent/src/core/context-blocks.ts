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

/** Render a whole text file given with `@path`, as the first prompt includes it. */
export function formatFileBlock(path: string, content: string): string {
	return `<file name="${path}">\n${content}\n</file>\n`;
}

/** The system prompt section that holds the context files, such as `AGENTS.md`. */
export const PROJECT_CONTEXT_SECTION = "project_context";

/** Render one context file for the system prompt's project context section. */
export function formatProjectInstructions(file: { path: string; content: string }): string {
	return `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`;
}

/**
 * Tool result `details` that mark the result text as the whole content of the file at `wholeFile.path`. The built-in
 * read tool sets them; a tool from an extension may set them too.
 */
export interface WholeFileDetails {
	wholeFile: { path: string };
}

/**
 * Send each version of a whole file to the model in full once. A block, which is a skill block, an `@path` file block,
 * or a tool result marked with {@link WholeFileDetails}, becomes a short note when the latest earlier full copy from the
 * same source has the same content; every other block stays in full. Context files in the system prompt count as full
 * copies from the point where the system prompt sets them. A changed file, a file whose earlier copy compaction
 * summarized, and a block that does not parse therefore cost a copy and never lose content. The result for a message
 * depends only on the messages before it, so appending messages keeps the prompt-cache prefix.
 */
export function collapseRepeatedContextBlocks(messages: Message[]): Message[] {
	// Source of a block, for example `skill:/path/SKILL.md`, to its latest full copy.
	const latest = new Map<string, LatestCopy>();
	/** The latest full copy when `content` repeats it; otherwise records `content` as the latest full copy. */
	const repeatedCopy = (source: string, content: string): LatestCopy | undefined => {
		const copy = latest.get(source);
		if (copy?.content === content) return copy;
		latest.set(source, { content, place: "conversation" });
		return undefined;
	};
	const collapseText = (text: string): string => {
		const skill = parseSkillBlock(text);
		if (skill) {
			if (!repeatedCopy(`skill:${skill.location}`, skill.content)) return text;
			return formatSkillBlock({ ...skill, content: SKILL_UNCHANGED });
		}
		return text.replace(FILE_BLOCK, (block, path: string, content: string) => {
			const copy = repeatedCopy(`file:${path}`, content);
			return copy ? formatFileBlock(path, fileUnchanged(path, copy)) : block;
		});
	};
	return messages.map((message) => {
		if (message.role === "system") {
			const projectContext = message.sections?.[PROJECT_CONTEXT_SECTION];
			if (projectContext === undefined) return message;
			for (const [source, copy] of latest) if (copy.place === "systemPrompt") latest.delete(source);
			for (const match of (projectContext ?? "").matchAll(PROJECT_INSTRUCTIONS)) {
				latest.set(`file:${match[1]}`, { content: match[2], place: "systemPrompt" });
			}
			return message;
		}
		if (message.role === "toolResult") {
			const path = wholeFilePath(message.details);
			if (path === undefined || message.content.some((part) => part.type !== "text")) return message;
			const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			const copy = repeatedCopy(`file:${path}`, text);
			return copy ? { ...message, content: [{ type: "text" as const, text: fileUnchanged(path, copy) }] } : message;
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

/** The path of a {@link WholeFileDetails} mark. Details come from session files and extension tools, so check them. */
function wholeFilePath(details: JsonValue | undefined): string | undefined {
	if (typeof details !== "object" || details === null || !("wholeFile" in details)) return undefined;
	const wholeFile = details.wholeFile;
	if (typeof wholeFile !== "object" || wholeFile === null || !("path" in wholeFile)) return undefined;
	return typeof wholeFile.path === "string" ? wholeFile.path : undefined;
}

/** Where the latest full copy of a source is: in the conversation, or in the system prompt's context files. */
interface LatestCopy {
	content: string;
	place: "conversation" | "systemPrompt";
}

// The format of formatFileBlock and formatProjectInstructions. A content holding the closing tag line parses short,
// which only costs a full copy later.
const FILE_BLOCK = /<file name="([^"]+)">\n([\s\S]*?)\n<\/file>\n/g;
const PROJECT_INSTRUCTIONS = /<project_instructions path="([^"]+)">\n([\s\S]*?)\n<\/project_instructions>/g;

function fileUnchanged(path: string, copy: LatestCopy): string {
	return copy.place === "systemPrompt"
		? `${path} has not changed. Its full content is in the system prompt as project instructions.`
		: `${path} has not changed since its full content last appeared earlier in this conversation. Use that content.`;
}

const SKILL_UNCHANGED =
	"This skill is already loaded and has not changed since it was last loaded earlier in this conversation. Follow those instructions.";
