import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";

const RULES = "/repo/AGENTS.md";

function systemPatch(projectContext: string | null): Message {
	return { role: "system", content: "", sections: { project_context: projectContext }, timestamp: 0 };
}

function readResult(text: string): Message {
	return {
		role: "toolResult",
		toolCallId: "call",
		toolName: "read",
		content: [{ type: "text", text }],
		details: { wholeFile: { path: RULES } },
		isError: false,
		timestamp: 0,
	};
}

describe("context files in model context", () => {
	it("sends a read of a context file in full after the system prompt removed it", () => {
		const projectContext = `Project-specific instructions and guidelines:\n\n<project_instructions path="${RULES}">\nRun the tests.\n</project_instructions>`;

		const sent = convertToLlm([
			systemPatch(projectContext),
			readResult("Run the tests."),
			systemPatch(null),
			readResult("Run the tests."),
		]);

		expect(sent.filter((message) => message.role === "toolResult").map((message) => message.content)).toEqual([
			[
				{
					type: "text",
					text: `${RULES} has not changed. Its full content is in the system prompt as project instructions.`,
				},
			],
			[{ type: "text", text: "Run the tests." }],
		]);
	});
});
