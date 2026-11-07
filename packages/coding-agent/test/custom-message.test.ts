import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { MarkdownTransformContext, MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { renderRestoredSkillsMessage } from "../src/modes/interactive/components/restored-skills-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CustomMessageComponent", () => {
	test("provides output padding to custom renderers and updates it", () => {
		initTheme("dark");
		const optionsSeen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			optionsSeen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, renderer, undefined, 1);

		expect(optionsSeen).toMatchObject([{ expanded: false, outputPad: 1 }]);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toMatchObject({ expanded: false, outputPad: 0 });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("custom")),
		).toBe(true);
	});

	test("runs Markdown transformers on default-rendered content", () => {
		initTheme("dark");
		const contexts: MarkdownTransformContext[] = [];
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "original",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(
			message,
			undefined,
			undefined,
			1,
			[
				(markdown, context) => {
					contexts.push(context);
					return markdown.replace("original", "transformed");
				},
			],
			"entry-1",
			"2025-01-15T10:30:00.000Z",
		);

		const rendered = component.render(40).map(stripAnsi).join("\n");
		expect(rendered).toContain("transformed");
		expect(rendered).not.toContain("original");
		expect(contexts[0]).toMatchObject({
			messageType: "custom",
			isStreaming: false,
			messageId: "entry-1",
			timestamp: "2025-01-15T10:30:00.000Z",
		});
	});

	test("shows a restored-skills message as one line of skill names, not the skills' text", () => {
		initTheme("dark");
		const message: CustomMessage = {
			role: "custom",
			customType: "restored-skills",
			content: [{ type: "text", text: '<skill name="alpha" location="/a">\nlong instructions\n</skill>' }],
			display: true,
			details: { restored: ["alpha", "beta"], tooLarge: ["gamma"] },
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, renderRestoredSkillsMessage, undefined, 1);

		expect(
			component
				.render(120)
				.map((line) => stripAnsi(line).trimEnd())
				.filter((line) => line.length > 0),
		).toEqual([" [skills restored after compaction] alpha, beta · too large, named only: gamma"]);
	});
});
