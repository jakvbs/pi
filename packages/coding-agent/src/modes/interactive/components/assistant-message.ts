import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownOptions,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { MarkdownMessageType, MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * A Markdown block of the last update. The next update reuses it at the same position for the same kind of content, so
 * a streamed answer keeps the blocks it already rendered, also once the stream ends.
 */
interface MarkdownSlot {
	kind: "text" | "note" | "thinking";
	markdown: Markdown;
}

/** How far a note of a folded turn is indented past the transcript padding: its bullet under the text of the row. */
const NOTE_BULLET_INDENT = 2;

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private messageId?: string;
	private timestamp?: string;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	private markdownSlots: MarkdownSlot[] = [];
	/**
	 * Set while this message is the reply or the commentary of a folded turn: thinking folds with the turn, the text and
	 * the stop notice stay. Commentary shows its text as a note of the turn's row.
	 */
	private activityFolded = false;
	/** Set while this message runs in a folded turn: each thinking run shows as its label line. */
	private thinkingCollapsed = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/** The message last shown, or undefined before the first update. */
	getMessage(): AssistantMessage | undefined {
		return this.lastMessage;
	}

	/** Whether the message shown is a finished response that ends its run, not a tool call step or a stream. */
	isReply(): boolean {
		return this.isFinished() && this.lastMessage?.stopReason !== "toolUse";
	}

	/** Whether the message shown has finished streaming. */
	isFinished(): boolean {
		return !this.isStreaming && this.lastMessage !== undefined;
	}

	/** Show each thinking run as its label line, so a response written in a folded turn keeps a steady height. */
	setThinkingCollapsed(collapsed: boolean): void {
		if (collapsed === this.thinkingCollapsed) return;
		this.thinkingCollapsed = collapsed;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/**
	 * Fold or show this message's thinking with its turn. While folded, an abort or error notice shows here even when the
	 * message has tool calls, because their rows, which show it otherwise, are folded too. A message that called tools
	 * then shows as a note below the row, so it does not read as the reply: muted, indented under the row's text, with a
	 * bullet on its first line and no blank line before it.
	 */
	setActivityFolded(folded: boolean): void {
		if (folded === this.activityFolded) return;
		this.activityFolded = folded;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		// Markdown takes its padding at construction.
		this.markdownSlots = [];
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();
		const previousSlots = this.markdownSlots;
		this.markdownSlots = [];
		const markdownBlock = (kind: MarkdownSlot["kind"], text: string, create: () => Markdown): Markdown => {
			const slot = previousSlots[this.markdownSlots.length];
			const markdown = slot?.kind === kind ? slot.markdown : create();
			markdown.setText(text);
			this.markdownSlots.push({ kind, markdown });
			return markdown;
		};

		const asNote = this.activityFolded && message.stopReason === "toolUse";
		let bulleted = false;

		// Spacers are added lazily, right before the next visible content block. This puts a blank
		// line before the first visible block and after each visible thinking run that is followed
		// by more visible content, while hidden thinking runs without a label contribute nothing.
		let needsSpacer = !asNote;
		const addVisibleChild = (child: Component) => {
			if (needsSpacer) {
				this.contentContainer.addChild(new Spacer(1));
				needsSpacer = false;
			}
			this.contentContainer.addChild(child);
		};

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const text = content.text.trim();
				if (asNote) {
					const bulletColumn = this.outputPad + NOTE_BULLET_INDENT;
					const note = markdownBlock(
						"note",
						text,
						() =>
							new Markdown(
								text,
								bulletColumn + 2,
								0,
								this.markdownTheme,
								{ color: (line: string) => theme.fg("muted", line) },
								this.markdownOptions("assistant"),
							),
					);
					addVisibleChild(bulleted ? note : withBullet(note, bulletColumn));
					bulleted = true;
				} else {
					addVisibleChild(
						markdownBlock(
							"text",
							text,
							() =>
								new Markdown(
									text,
									this.outputPad,
									0,
									this.markdownTheme,
									undefined,
									this.markdownOptions("assistant"),
								),
						),
					);
				}
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				const runIndex = thinkingRunIndex++;
				if (this.activityFolded) {
					continue;
				}
				const hidden =
					this.thinkingCollapsed || (this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock);
				// A hidden run with an empty label renders nothing, including no spacing.
				if (hidden && !this.hiddenThinkingLabel.trim()) {
					continue;
				}
				const thinking = thinkingBlocks.join("\n\n");
				const thinkingComponent = hidden
					? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0)
					: markdownBlock(
							"thinking",
							thinking,
							() =>
								new Markdown(
									thinking,
									this.outputPad,
									0,
									this.markdownTheme,
									{
										color: (text: string) => theme.fg("thinkingText", text),
										italic: true,
									},
									this.markdownOptions("assistant-thinking"),
								),
						);
				addVisibleChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				needsSpacer = true;
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		const showsStopNotice = !hasToolCalls || this.activityFolded;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (showsStopNotice) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}

	private markdownOptions(messageType: MarkdownMessageType): MarkdownOptions {
		return {
			transform: createMarkdownTransform(
				messageType,
				() => this.isStreaming,
				this.markdownTransformers,
				this.messageId,
				this.timestamp,
			),
		};
	}
}

/** Put a bullet at `column` of a block's first line, which the block's padding keeps blank. */
function withBullet(block: Component, column: number): Component {
	return {
		render: (width) => {
			const [first = "", ...rest] = block.render(width);
			return [`${first.slice(0, column)}${theme.fg("muted", "•")}${first.slice(column + 1)}`, ...rest];
		},
		invalidate: () => block.invalidate(),
	};
}
