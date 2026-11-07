// The text a `/skill:name` command expands to, and how model context carries repeats of it.
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
 * Keep the first copy of each skill block in `messages` and replace every later identical copy with a short
 * note. A copy stays in full when no identical copy precedes it in these messages, for example after
 * compaction summarized the earlier one, or when the skill file changed between invocations. The result for
 * a message depends only on the messages before it, so appending messages keeps the prompt-cache prefix.
 */
export function collapseRepeatedSkillBlocks(messages: Message[]): Message[] {
	const loaded = new Set<string>();
	const collapse = (text: string): string => {
		const block = parseSkillBlock(text);
		if (!block) return text;
		const key = JSON.stringify([block.name, block.location, block.content]);
		if (!loaded.has(key)) {
			loaded.add(key);
			return text;
		}
		return formatSkillBlock({ ...block, content: SKILL_ALREADY_LOADED });
	};
	return messages.map((message) => {
		if (message.role !== "user") return message;
		if (typeof message.content === "string") {
			const content = collapse(message.content);
			return content === message.content ? message : { ...message, content };
		}
		const content = message.content.map((part) => {
			if (part.type !== "text") return part;
			const text = collapse(part.text);
			return text === part.text ? part : { ...part, text };
		});
		return content.every((part, index) => part === message.content[index]) ? message : { ...message, content };
	});
}

const SKILL_ALREADY_LOADED =
	"This skill is already loaded. Its full instructions appear earlier in this conversation. Follow them.";
