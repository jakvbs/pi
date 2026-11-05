// Turns pi's messages into the steps and goals the handoff model reads.
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Step } from "./tracker.ts";

/** A step from one response and the tool results it led to; it ends at the last of them. */
export function toStep(message: AssistantMessage, results: readonly ToolResultMessage[]): Step {
	const byId = new Map(results.map((result) => [result.toolCallId, result]));
	let thinking = "";
	let text = "";
	const calls: Step["calls"] = [];
	for (const part of message.content) {
		if (part.type === "thinking") thinking += `${part.thinking}\n`;
		else if (part.type === "text") text += `${part.text}\n`;
		else {
			const result = byId.get(part.id);
			calls.push({
				name: part.name,
				args: JSON.stringify(part.arguments),
				result: result ? contentText(result.content) : "(no result)",
				isError: result?.isError ?? false,
			});
		}
	}
	const at = Math.max(message.timestamp + (message.durationMs ?? 0), ...results.map((result) => result.timestamp));
	return { at, thinking: thinking.trim(), text: text.trim(), calls };
}

/** The text of a message's content; images count as a marker. */
export function contentText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}
