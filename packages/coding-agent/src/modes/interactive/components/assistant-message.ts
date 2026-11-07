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
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { MarkdownMessageType, MarkdownTransformer } from "../../../core/extensions/types.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { formatUsage, type StepUsage } from "./step-usage.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * A Markdown block of the last update. The next update reuses it at the same position for the same kind of content, so
 * a streamed answer keeps the blocks it already rendered, also once the stream ends.
 */
interface MarkdownSlot {
	kind: "text" | "thinking";
	markdown: Markdown;
}

/**
 * Where a message stands in its turn: shown in full, written while its turn folds, or the commentary or reply of a
 * folded part of a turn, whose row counts its thinking.
 */
export type MessagePlace = "full" | "live" | "folded";

/** How one thinking run shows: not at all, as its label line, as its last lines while it is written, or in full. */
type ThinkingView = "none" | "label" | "window" | "text";

/** How many lines a thinking run written in a folded turn shows, its last ones, so the turn keeps a steady height. */
const THINKING_WINDOW_LINES = 4;

/** How a thinking run shows, from where its message stands, whether the run is hidden, and the hidden label. */
function thinkingView(place: MessagePlace, hidden: boolean, hiddenLabel: string): ThinkingView {
	if (place === "folded") return "none";
	if (hidden) return hiddenLabel.trim() ? "label" : "none";
	return place === "live" ? "window" : "text";
}

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
	private place: MessagePlace = "full";
	/** Set on a reply: its step usage, shown at the right below it unless its turn is folded, whose row sums it. */
	private stepUsage: StepUsage | undefined;
	/** Set on the reply of a turn folded into several parts: the turn's totals, shown below it while it is folded. */
	private turnSummary: (() => string) | undefined;

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

	/**
	 * Show this message where it stands in its turn. Written in a folded turn, each visible thinking run shows its last
	 * lines. Folded, its thinking goes, and an abort or error notice shows here even when the message has tool calls,
	 * because their rows, which show it otherwise, are folded too; commentary then follows its part's row without a blank
	 * line, so it reads as the end of that part, and a reply shows its turn's totals instead of its step usage.
	 */
	setPlace(place: MessagePlace): void {
		if (place === this.place) return;
		this.place = place;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/** Show the totals of this reply's turn below it while the turn is folded; they are read at each render. */
	setTurnSummary(summary: () => string): void {
		this.turnSummary = summary;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/** Show the usage of this reply's step below it. */
	setStepUsage(usage: StepUsage): void {
		this.stepUsage = usage;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/** The usage of this reply's step; undefined for a message that used tools, whose first tool row has it. */
	getStepUsage(): StepUsage | undefined {
		return this.stepUsage;
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

		// Spacers are added lazily, right before the next visible content block. This puts a blank
		// line before the first visible block and after each visible thinking run that is followed
		// by more visible content, while hidden thinking runs without a label contribute nothing.
		let needsSpacer = !(this.place === "folded" && message.stopReason === "toolUse");
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
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				const view = thinkingView(this.place, hidden, this.hiddenThinkingLabel);
				// A run that shows nothing adds no spacing either.
				if (view === "none") {
					continue;
				}
				const thinkingMarkdown = (thinking: string) =>
					markdownBlock(
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
				const thinking = thinkingBlocks.join("\n\n");
				const thinkingComponent =
					view === "label"
						? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0)
						: view === "window"
							? lastLines(
									thinkingMarkdown(lastSourceLines(thinking, THINKING_WINDOW_LINES)),
									THINKING_WINDOW_LINES,
								)
							: thinkingMarkdown(thinking);
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
		const showsStopNotice = !hasToolCalls || this.place === "folded";
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

		// Step usage and turn totals change after this update, when later calls report, so each render reads them.
		const usage = this.stepUsage;
		const turnSummary = this.turnSummary;
		const footnote = this.place === "folded" ? turnSummary : usage ? () => formatUsage(usage) : undefined;
		if (footnote) {
			this.contentContainer.addChild({
				render: (width) => {
					const text = footnote();
					const room = width - this.outputPad - visibleWidth(text);
					return text && room >= 0 ? [`${" ".repeat(room)}${theme.fg("dim", text)}`] : [];
				},
				invalidate: () => {},
			});
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

/** The text from the `count`-th last non-empty line on, so a long thinking run is not rendered whole for its window. */
function lastSourceLines(text: string, count: number): string {
	const lines = text.split("\n");
	let start = lines.length;
	for (let kept = 0; start > 0 && kept < count; ) {
		start--;
		if (lines[start].trim()) kept++;
	}
	return lines.slice(start).join("\n");
}

/** The last `count` lines a block renders that are not blank. */
function lastLines(block: Component, count: number): Component {
	return {
		render: (width) =>
			block
				.render(width)
				.filter((line) => stripAnsi(line).trim() !== "")
				.slice(-count),
		invalidate: () => block.invalidate(),
	};
}
