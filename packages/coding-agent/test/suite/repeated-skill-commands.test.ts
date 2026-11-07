import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

const ALREADY_LOADED =
	"This skill is already loaded. Its full instructions appear earlier in this conversation. Follow them.";

describe("repeated skill commands", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	async function createSkillHarness(body: string, extensions: ExtensionFactory[] = []) {
		const skillDir = mkdtempSync(join(tmpdir(), "pi-repeated-skill-"));
		tempDirs.push(skillDir);
		const skillPath = join(skillDir, "SKILL.md");
		writeFileSync(skillPath, body);
		const resourceLoader: ResourceLoader = {
			...createTestResourceLoader({ extensionsResult: await createTestExtensionsResult(extensions, skillDir) }),
			getSkills: () => ({
				skills: [
					{
						name: "test",
						description: "Test skill",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: skillDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: skillDir,
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({ resourceLoader, settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		const requests: string[][] = [];
		const reply = (context: TranscriptContext) => {
			requests.push(
				context.messages.filter((message) => message.role === "user").map((message) => getMessageText(message)),
			);
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([reply, reply, reply]);
		const skillBlock = (content: string) => `<skill name="test" location="${skillPath}">\n${content}\n</skill>`;
		const fullBlock = (skillBody: string) => skillBlock(`References are relative to ${skillDir}.\n\n${skillBody}`);
		return { harness, requests, skillPath, skillBlock, fullBlock };
	}

	it("sends a repeat of an identical skill as a note and keeps the full text in the session", async () => {
		const { harness, requests, skillBlock, fullBlock } = await createSkillHarness("Use the skill body.");

		await harness.session.prompt("/skill:test first");
		await harness.session.prompt("/skill:test second");

		expect(requests[1]).toEqual([
			`${fullBlock("Use the skill body.")}\n\nfirst`,
			`${skillBlock(ALREADY_LOADED)}\n\nsecond`,
		]);
		expect(getUserTexts(harness)).toEqual([
			`${fullBlock("Use the skill body.")}\n\nfirst`,
			`${fullBlock("Use the skill body.")}\n\nsecond`,
		]);
	});

	it("sends the skill in full again when its file changed between invocations", async () => {
		const { harness, requests, skillPath, fullBlock } = await createSkillHarness("Use the old body.");

		await harness.session.prompt("/skill:test first");
		writeFileSync(skillPath, "Use the new body.");
		await harness.session.prompt("/skill:test second");

		expect(requests[1]).toEqual([
			`${fullBlock("Use the old body.")}\n\nfirst`,
			`${fullBlock("Use the new body.")}\n\nsecond`,
		]);
	});

	it("sends the repeat in full once compaction summarized the first copy", async () => {
		let firstKeptEntryId = "";
		const { harness, requests, skillBlock, fullBlock } = await createSkillHarness("Use the skill body.", [
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "summary of the first skill run",
						firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
		]);

		await harness.session.prompt("/skill:test first");
		await harness.session.prompt("/skill:test second");
		const userEntries = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user");
		firstKeptEntryId = userEntries[1]!.id;
		await harness.session.compact();
		await harness.session.prompt("third");

		expect(requests[1]?.[1]).toBe(`${skillBlock(ALREADY_LOADED)}\n\nsecond`);
		expect(requests[2]).toEqual([
			"The conversation history before this point was compacted into the following summary:\n\n<summary>\nsummary of the first skill run\n</summary>",
			`${fullBlock("Use the skill body.")}\n\nsecond`,
			"third",
		]);
	});
});
