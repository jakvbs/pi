// Folds the activity of each finished turn (thinking, tool calls, commentary) into one row between the user message
// and the reply.
import { type Component, Container, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { ToolExecutionComponent, TranscriptContainer } from "./tool-execution.ts";

/** What a folded turn did, as its row shows it. */
export interface TurnSummary {
	tools: number;
	/** Non-empty thinking blocks, also the reply's. */
	thinking: number;
	/** Tool calls that ended with an error. */
	errors: number;
	/** From the start of the turn to the end of its last response; undefined when the messages carry no times. */
	durationMs: number | undefined;
}

/**
 * Tracks the open turn of a transcript and folds it when it ends. A turn starts after a row that opens it (a user
 * message, a compaction marker) and ends at the next such row or when the agent run ends. Its reply is the last
 * assistant message whose stop reason is not `toolUse`; everything else the turn added folds into one row above the
 * reply, except rows the reply is followed by that are not tool calls (notices about the reply).
 */
export class TurnFolds {
	private readonly transcript: Container;
	private folding: boolean;
	private outputPad: number;
	private openTurn: { after: Component | undefined; startedAt: number | undefined } | undefined;

	constructor(transcript: Container, folding: boolean, outputPad: number) {
		this.transcript = transcript;
		this.folding = folding;
		this.outputPad = outputPad;
	}

	/** Open a turn after the transcript's current last row. */
	start(startedAt: number | undefined): void {
		const children = this.transcript.children;
		this.openTurn = { after: children[children.length - 1], startedAt };
	}

	/** Forget the open turn without folding it, for a transcript that is about to be rebuilt. */
	reset(): void {
		this.openTurn = undefined;
	}

	/** Fold the open turn, if any. A turn without tool calls and thinking keeps its rows and gets no fold row. */
	end(): void {
		const turn = this.openTurn;
		this.openTurn = undefined;
		if (!turn) return;
		const children = this.transcript.children;
		const start = turn.after === undefined ? 0 : children.indexOf(turn.after) + 1;
		// The row that opened the turn is gone: the transcript was cleared since.
		if (start === 0 && turn.after !== undefined) return;

		const rows = children.slice(start);
		let replyIndex = -1;
		for (let i = rows.length - 1; i >= 0 && replyIndex < 0; i--) {
			const row = rows[i];
			if (row instanceof AssistantMessageComponent && row.getMessage()?.stopReason !== "toolUse") replyIndex = i;
		}
		const reply = rows[replyIndex];
		const activity: Component[] = [];
		const afterReply: Component[] = [];
		rows.forEach((row, index) => {
			if (index === replyIndex) return;
			const folds = replyIndex < 0 || index < replyIndex || row instanceof ToolExecutionComponent;
			(folds ? activity : afterReply).push(row);
		});
		const replyComponent = reply instanceof AssistantMessageComponent ? reply : undefined;
		const summary = summarizeTurn(activity, replyComponent, turn.startedAt);
		if (summary.tools === 0 && summary.thinking === 0) return;

		const fold = new TurnFoldComponent(activity, replyComponent, summary, this.folding, this.outputPad);
		children.splice(start, rows.length, fold, ...(replyComponent ? [replyComponent] : []), ...afterReply);
	}

	/** Whether finished turns fold. */
	isFolding(): boolean {
		return this.folding;
	}

	/** Fold every finished turn, or show every turn in full. Folding again closes rows opened one by one. */
	setFolding(folding: boolean): void {
		this.folding = folding;
		for (const child of this.transcript.children) {
			if (child instanceof TurnFoldComponent) child.setFolding(folding);
		}
	}

	/** Open or fold the row of the last finished turn. Returns false when there is no such row to toggle. */
	toggleLast(): boolean {
		if (!this.folding) return false;
		const children = this.transcript.children;
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			if (child instanceof TurnFoldComponent) {
				child.toggle();
				return true;
			}
		}
		return false;
	}

	/** Pad new fold rows like the rest of the transcript; existing rows are updated through {@link transcriptRows}. */
	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
	}
}

/** Every row of a transcript, also the rows folded into turns, so settings reach them. */
export function* transcriptRows(transcript: Container): Generator<Component> {
	for (const child of transcript.children) {
		yield child;
		if (child instanceof TurnFoldComponent) yield* child.getActivityRows();
	}
}

/** Count what a turn did from its rows. */
export function summarizeTurn(
	activity: readonly Component[],
	reply: AssistantMessageComponent | undefined,
	startedAt: number | undefined,
): TurnSummary {
	let tools = 0;
	let thinking = 0;
	let errors = 0;
	let firstStart: number | undefined;
	let lastEnd: number | undefined;
	for (const row of reply ? [...activity, reply] : activity) {
		if (row instanceof ToolExecutionComponent) {
			tools++;
			if (row.isError()) errors++;
		} else if (row instanceof AssistantMessageComponent) {
			const message = row.getMessage();
			if (!message) continue;
			thinking += message.content.filter((part) => part.type === "thinking" && part.thinking.trim()).length;
			firstStart ??= message.timestamp;
			lastEnd = message.timestamp + (message.durationMs ?? 0);
		}
	}
	const start = startedAt ?? firstStart;
	const durationMs = start !== undefined && lastEnd !== undefined && lastEnd >= start ? lastEnd - start : undefined;
	return { tools, thinking, errors, durationMs };
}

/** The row text without its open/closed glyph, for example `12 tools · 9 thinking · 1:40 · 2 errors`. */
export function formatTurnSummary(summary: TurnSummary): string {
	const parts: string[] = [];
	if (summary.tools > 0) parts.push(`${summary.tools} ${summary.tools === 1 ? "tool" : "tools"}`);
	if (summary.thinking > 0) parts.push(`${summary.thinking} thinking`);
	if (summary.durationMs !== undefined) parts.push(formatDuration(summary.durationMs));
	if (summary.errors > 0) parts.push(`${summary.errors} ${summary.errors === 1 ? "error" : "errors"}`);
	return parts.join(" · ");
}

function formatDuration(durationMs: number): string {
	const totalSeconds = Math.round(durationMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = String(totalSeconds % 60).padStart(2, "0");
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * The fold row of one finished turn, followed by the turn's activity while it is open. With folding off it shows the
 * activity alone, as before folding existed. The reply stays outside, after this component.
 */
export class TurnFoldComponent extends Container {
	private readonly activity: TranscriptContainer;
	private readonly reply: AssistantMessageComponent | undefined;
	private readonly summary: TurnSummary;
	private readonly header: Component;
	private folding: boolean;
	private open = false;
	private outputPad: number;

	constructor(
		activity: readonly Component[],
		reply: AssistantMessageComponent | undefined,
		summary: TurnSummary,
		folding: boolean,
		outputPad: number,
	) {
		super();
		this.activity = new TranscriptContainer();
		for (const row of activity) this.activity.addChild(row);
		this.reply = reply;
		this.summary = summary;
		this.folding = folding;
		this.outputPad = outputPad;
		this.header = {
			render: (width) => ["", this.renderRow(width)],
			handleMouse: (event: TuiMouseEvent) => {
				if (event.y !== 1 || event.type !== "click" || event.button !== "left") return undefined;
				this.toggle();
				return { handled: true };
			},
			invalidate: () => {},
		};
		this.update();
	}

	/** The rows folded into this turn. */
	getActivityRows(): readonly Component[] {
		return this.activity.children;
	}

	/** Open or fold this turn. Does nothing while folding is off. */
	toggle(): void {
		if (!this.folding) return;
		this.open = !this.open;
		this.update();
	}

	/** Turn folding on (closed) or off (activity shown without a row). */
	setFolding(folding: boolean): void {
		this.folding = folding;
		this.open = false;
		this.update();
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
	}

	private update(): void {
		this.children = !this.folding ? [this.activity] : this.open ? [this.header, this.activity] : [this.header];
		this.reply?.setActivityFolded(this.folding && !this.open);
	}

	private renderRow(width: number): string {
		const glyph = this.open ? "▾" : "▸";
		const text = formatTurnSummary({ ...this.summary, errors: 0 });
		const errors = formatTurnSummary({ tools: 0, thinking: 0, durationMs: undefined, errors: this.summary.errors });
		const errorPart = errors ? theme.fg("error", ` · ${errors}`) : "";
		return truncateToWidth(
			`${" ".repeat(this.outputPad)}${theme.fg("muted", `${glyph} ${text}`)}${errorPart}`,
			width,
		);
	}
}
