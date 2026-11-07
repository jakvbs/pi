// The message that brings back, after compaction, the skills that compaction removed from model context.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { formatSkillBlock, parseSkillBlock, skillBlockContent, wholeFilePath } from "./context-blocks.ts";
import type { Skill } from "./skills.ts";

/** Custom message type of the message that restores skills after compaction. */
export const RESTORED_SKILLS_MESSAGE_TYPE = "restored-skills";

/** Skills a restored-skills message brings back in full, and skills it only names because they do not fit. */
export interface RestoredSkillsDetails {
	restored: string[];
	tooLarge: string[];
}

/** The details of a restored-skills message read from a session file, which may hold any value. */
export function readRestoredSkillsDetails(details: unknown): RestoredSkillsDetails {
	const names = (value: unknown) =>
		Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
	if (typeof details !== "object" || details === null) return { restored: [], tooLarge: [] };
	return {
		restored: names("restored" in details ? details.restored : undefined),
		tooLarge: names("tooLarge" in details ? details.tooLarge : undefined),
	};
}

/**
 * The message that restores each skill whose latest copy on the branch is no longer in model context after a
 * compaction. Skills come newest first, each in full while it fits {@link MAX_SKILL_TOKENS} and the total budget
 * (25,000 tokens or a tenth of the context window, whichever is smaller); any other skill is named with its path so
 * the model can read it again. Undefined when compaction removed no skill.
 */
export function buildRestoredSkillsMessage(
	branchMessages: AgentMessage[],
	contextMessages: AgentMessage[],
	skills: Skill[],
	contextWindow: number | undefined,
): { content: TextContent[]; details: RestoredSkillsDetails } | undefined {
	const visible = latestSkillCopies(contextMessages, skills);
	const removed = [...latestSkillCopies(branchMessages, skills).values()]
		.filter((copy) => visible.get(copy.location)?.content !== copy.content)
		.reverse();
	if (removed.length === 0) return undefined;

	let budget = contextWindow ? Math.min(MAX_TOTAL_TOKENS, Math.floor(contextWindow / 10)) : MAX_TOTAL_TOKENS;
	const content: TextContent[] = [{ type: "text", text: RESTORED_SKILLS_INTRO }];
	const details: RestoredSkillsDetails = { restored: [], tooLarge: [] };
	for (const copy of removed) {
		const block = formatSkillBlock({ ...copy, userMessage: undefined });
		const tokens = Math.ceil(block.length / 4);
		if (tokens <= MAX_SKILL_TOKENS && tokens <= budget) {
			budget -= tokens;
			content.push({ type: "text", text: block });
			details.restored.push(copy.name);
		} else {
			content.push({ type: "text", text: tooLargeNote(copy) });
			details.tooLarge.push(copy.name);
		}
	}
	return { content, details };
}

const MAX_SKILL_TOKENS = 8000;
const MAX_TOTAL_TOKENS = 25000;

interface SkillCopy {
	name: string;
	location: string;
	content: string;
}

/**
 * The latest copy of each skill in `messages`, oldest first: skill blocks in user and custom messages, and whole-file
 * reads of a skill's file turned into the skill block that `/skill:name` sends.
 */
function latestSkillCopies(messages: AgentMessage[], skills: Skill[]): Map<string, SkillCopy> {
	const copies = new Map<string, SkillCopy>();
	const record = (copy: SkillCopy) => {
		copies.delete(copy.location);
		copies.set(copy.location, copy);
	};
	for (const message of messages) {
		if (message.role === "user" || message.role === "custom") {
			const parts = typeof message.content === "string" ? [message.content] : textsOf(message.content);
			for (const text of parts) {
				const block = parseSkillBlock(text);
				if (block) record(block);
			}
		} else if (message.role === "toolResult") {
			const path = wholeFilePath(message.details);
			const skill = path === undefined ? undefined : skills.find((candidate) => candidate.filePath === path);
			if (skill) {
				const content = skillBlockContent(skill.baseDir, textsOf(message.content).join(""));
				record({ name: skill.name, location: skill.filePath, content });
			}
		}
	}
	return copies;
}

function textsOf(content: readonly (TextContent | ImageContent)[]): string[] {
	return content.flatMap((part) => (part.type === "text" ? [part.text] : []));
}

function tooLargeNote(copy: SkillCopy): string {
	return `The skill "${copy.name}" was also loaded before compaction, but it is too large to restore here. Read ${copy.location} again when you need it.`;
}

const RESTORED_SKILLS_INTRO =
	"Compaction removed these skills from the conversation. They are restored here as they were last loaded.";
