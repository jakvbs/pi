// Blocks that carry a whole file into model context, and how model context carries their repeats.
import type { Message } from "@earendil-works/pi-ai";

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
 * Send each version of a whole file to the model in full once. A block becomes a short note when the latest earlier
 * full copy from the same source has the same content; every other block stays in full. A changed file, a file whose
 * earlier copy compaction summarized, and a block that does not parse therefore cost a copy and never lose content.
 * The result for a message depends only on the messages before it, so appending messages keeps the prompt-cache prefix.
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

const SKILL_UNCHANGED =
	"This skill is already loaded and has not changed since it was last loaded earlier in this conversation. Follow those instructions.";
