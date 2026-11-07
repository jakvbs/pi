import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { buildRestoredSkillsMessage } from "../src/core/restored-skills.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

function skill(name: string): Skill {
	const filePath = `/skills/${name}/SKILL.md`;
	return {
		name,
		description: `${name} skill`,
		filePath,
		baseDir: `/skills/${name}`,
		disableModelInvocation: false,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "user", origin: "top-level" }),
	};
}

function skillCommand(name: string, body: string): AgentMessage {
	return {
		role: "user",
		content: `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\n${body}\n</skill>\n\ngo`,
		timestamp: 0,
	};
}

describe("buildRestoredSkillsMessage", () => {
	it("restores a skill read with the read tool as the block /skill sends", () => {
		const read: AgentMessage = {
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "---\nname: alpha\ndescription: alpha skill\n---\n\nUse alpha.\n" }],
			details: { wholeFile: { path: "/skills/alpha/SKILL.md" } },
			isError: false,
			timestamp: 0,
		};

		const message = buildRestoredSkillsMessage([read], [], [skill("alpha")], 200_000);

		expect(message?.content.map((part) => part.text)).toEqual([
			"Compaction removed these skills from the conversation. They are restored here as they were last loaded.",
			'<skill name="alpha" location="/skills/alpha/SKILL.md">\nReferences are relative to /skills/alpha.\n\nUse alpha.\n</skill>',
		]);
		expect(message?.details).toEqual({ restored: ["alpha"], tooLarge: [] });
	});

	it("restores nothing when the latest copy of each skill is still in context", () => {
		const command = skillCommand("alpha", "Use alpha.");

		expect(buildRestoredSkillsMessage([command], [command], [skill("alpha")], 200_000)).toBeUndefined();
		expect(buildRestoredSkillsMessage([command], [], [skill("alpha")], 200_000)?.details.restored).toEqual(["alpha"]);
	});

	it("names a skill over 8,000 tokens with its path instead of restoring it", () => {
		const message = buildRestoredSkillsMessage(
			[skillCommand("alpha", "x".repeat(33_000))],
			[],
			[skill("alpha")],
			1_000_000,
		);

		expect(message?.content.map((part) => part.text).slice(1)).toEqual([
			'The skill "alpha" was also loaded before compaction, but it is too large to restore here. Read /skills/alpha/SKILL.md again when you need it.',
		]);
		expect(message?.details).toEqual({ restored: [], tooLarge: ["alpha"] });
	});

	it("restores the newest skills first within a tenth of the context window", () => {
		const message = buildRestoredSkillsMessage(
			[skillCommand("older", "o".repeat(8_000)), skillCommand("newer", "n".repeat(8_000))],
			[],
			[skill("older"), skill("newer")],
			30_000,
		);

		expect(message?.details).toEqual({ restored: ["newer"], tooLarge: ["older"] });
	});
});
