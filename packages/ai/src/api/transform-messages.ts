import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { makeReplayable } from "../utils/transcript.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
const ERROR_TOOL_IMAGE_PLACEHOLDER = "(image attached after the tool results)";

/** An error tool result split into a text-only result and the images to send after the tool results. */
export interface SplitErrorToolResult {
	/** The result content with each run of images replaced by a note. */
	content: TextContent[];
	/** Text naming the tool call, to send before `images`. */
	caption: string;
	images: ImageContent[];
}

/**
 * Split the images out of an error tool result, for APIs that reject images in error results
 * (Anthropic, and Claude on Bedrock). Send the returned content as the tool result and the caption and
 * images after all tool results of the turn, in the same user message. Returns undefined for results
 * that need no split (#10794).
 */
export function splitErrorToolResultImages(msg: ToolResultMessage): SplitErrorToolResult | undefined {
	if (!msg.isError) return undefined;
	const images = msg.content.filter((block): block is ImageContent => block.type === "image");
	if (images.length === 0) return undefined;
	return {
		content: replaceImagesWithPlaceholder(msg.content, ERROR_TOOL_IMAGE_PLACEHOLDER),
		caption: `Images from the error result of tool call ${msg.toolCallId} (${msg.toolName}):`,
		images,
	};
}

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	// Callers also pass message lists that did not come through normalizeContext (a single reply,
	// hand-built histories), so make them replayable here too. A tool result added for a missing
	// one follows its call, so the pass below maps its ID like a real result's.
	const imageAwareMessages = downgradeUnsupportedImages(makeReplayable(messages), model);

	// Transform thinking blocks and normalize tool call IDs
	return imageAwareMessages.map((msg) => {
		// System and user messages pass through unchanged
		if (msg.role === "system" || msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Thinking from another model is dropped. Signatures and encrypted reasoning are
					// only valid for the model that produced them, and sending readable thinking as
					// plain text makes the new model treat it as part of the visible reply.
					if (!isSameModel) return [];
					// Keep redacted and signed blocks even if the thinking text is empty
					// (OpenAI encrypted reasoning); they are needed for replay.
					if (block.redacted || block.thinkingSignature) return block;
					if (!block.thinking || block.thinking.trim() === "") return [];
					return block;
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});
}
