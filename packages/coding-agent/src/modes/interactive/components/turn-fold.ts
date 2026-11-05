// Folds the activity of each turn (thinking, tool calls, commentary) into one row between the user message and the
// reply, also while the turn runs.
import { type Component, Container, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { CustomMessageComponent } from "./custom-message.ts";
import { ToolExecutionComponent, TranscriptContainer } from "./tool-execution.ts";

/** What a folded turn did, as its row shows it. */
export interface TurnSummary {
	tools: number;
	/** Non-empty thinking blocks, also the reply's. */
	thinking: number;
	/** Tool calls that ended with an error. */
	errors: number;
	/**
	 * From the message that opened the turn to the end of its last response or tool result, whichever is later;
	 * undefined without a response.
	 */
	durationMs: number | undefined;
}

/** Where a turn's rows lie in the transcript: after its opening rows, up to the end of the transcript. */
interface Turn {
	/** The last row of the opener; undefined when the turn opened at the top of the transcript. */
	after: Component | undefined;
	startedAt: number;
	/** The row the turn folds into while it runs, from its first finished tool call or thinking on. */
	fold: TurnFoldComponent | undefined;
}

/**
 * Tracks the open turn of a transcript and folds it as soon as its reply arrives ({@link TurnFolds.end}). A turn starts
 * after a row that opens it (a user message, a `!` command, a compaction or branch-summary marker, an extension message
 * after a reply), or at an assistant message that follows a folded turn without such a row, such as an automatic retry
 * after a failed reply. Its reply is the last assistant message whose stop reason is not `toolUse`; everything else the
 * turn added folds into one row above the reply, except extension messages (notices that stay visible in their place)
 * and rows the reply is followed by that are not tool calls (notices about the reply).
 *
 * While the turn runs, its finished rows fold into the same row as they finish ({@link TurnFolds.foldFinished}), so
 * only what still runs shows below it: the response being written, with its thinking as one label line, and the tool
 * calls that have no result yet.
 */
export class TurnFolds {
	private readonly transcript: Container;
	private folding: boolean;
	private outputPad: number;
	private openTurn: Turn | undefined;

	constructor(transcript: Container, folding: boolean, outputPad: number) {
		this.transcript = transcript;
		this.folding = folding;
		this.outputPad = outputPad;
	}

	/** Open a turn after the transcript's current last row. */
	start(startedAt: number): void {
		this.openTurn = { after: this.lastRow(), startedAt, fold: undefined };
	}

	/**
	 * Open a turn at an assistant message that follows a folded turn without a row to open it, such as a retry after a
	 * failed reply. Does nothing while a turn is open.
	 */
	resume(startedAt: number): void {
		if (!this.openTurn) this.start(startedAt);
	}

	/** Count the rows added since the open turn started as part of the row that opened it, such as its cost notice. */
	keepWithOpener(): void {
		if (this.openTurn) this.openTurn.after = this.lastRow();
	}

	/** Whether a turn is open and still waits for its reply, so a message from an extension belongs inside it. */
	awaitsReply(): boolean {
		const rows = this.openTurn ? this.rowsOf(this.openTurn) : undefined;
		return rows !== undefined && !rows.some(isReply);
	}

	/** Forget the open turn without folding it, for a transcript that is about to be rebuilt. */
	reset(): void {
		this.openTurn = undefined;
	}

	/**
	 * Fold the open turn, at its reply or before a row that opens the next turn. A turn without tool calls and thinking
	 * keeps its rows and gets no fold row.
	 */
	end(): void {
		const open = this.openTurn;
		this.openTurn = undefined;
		if (open) this.fold(open);
	}

	/**
	 * Fold the rows of the open turn that have finished, in order up to the first one still running: responses that
	 * called tools, tool calls with their result, notices. The fold row appears with the first tool call or thinking.
	 */
	foldFinished(): void {
		const turn = this.openTurn;
		const rows = turn ? this.rowsOf(turn) : undefined;
		if (!turn || !rows) return;

		const finished: Component[] = [];
		for (const row of rows) {
			if (row === turn.fold || row instanceof CustomMessageComponent) continue;
			if (!isFinishedActivity(row)) break;
			finished.push(row);
		}
		const summary = summarizeTurn(finished, undefined, turn.startedAt);
		if (finished.length > 0 && (turn.fold || summary.tools > 0 || summary.thinking > 0)) {
			const fold = turn.fold ?? new TurnFoldComponent(turn.startedAt, this.folding, this.outputPad);
			const shown = rows.flatMap((row) =>
				!turn.fold && row === finished[0] ? [fold] : finished.includes(row) ? [] : [row],
			);
			this.transcript.children.splice(this.firstRowIndex(turn), rows.length, ...shown);
			for (const row of finished) if (row instanceof AssistantMessageComponent) row.setThinkingCollapsed(false);
			fold.absorb(finished);
			turn.fold = fold;
		}
		this.collapseRunningThinking();
	}

	/** Replace the rows of one turn with its fold row and visible rows. */
	private fold(turn: Turn): void {
		const rows = this.rowsOf(turn);
		if (!rows) return;

		const reply = rows.findLast(isReply);
		const replyIndex = reply ? rows.lastIndexOf(reply) : -1;
		const folds = (row: Component, index: number): boolean =>
			row !== turn.fold &&
			index !== replyIndex &&
			!(row instanceof CustomMessageComponent) &&
			(replyIndex < 0 || index < replyIndex || row instanceof ToolExecutionComponent);
		const activity = rows.filter(folds);
		for (const row of rows) if (row instanceof AssistantMessageComponent) row.setThinkingCollapsed(false);
		const summary = summarizeTurn(activity, reply, turn.startedAt);
		if (!turn.fold && summary.tools === 0 && summary.thinking === 0) return;

		// A new row takes the place of the first row it folds, or of the reply if that comes first; the rest keep order.
		const fold = turn.fold ?? new TurnFoldComponent(turn.startedAt, this.folding, this.outputPad);
		const shown: Component[] = [];
		let placed = turn.fold !== undefined;
		rows.forEach((row, index) => {
			const folded = folds(row, index);
			if (!placed && (folded || index === replyIndex)) {
				shown.push(fold);
				placed = true;
			}
			if (!folded) shown.push(row);
		});
		this.transcript.children.splice(this.firstRowIndex(turn), rows.length, ...shown);
		fold.absorb(activity);
		fold.finish(reply);
	}

	/** Show the thinking of the open turn's running response as its label line while the turn folds. */
	private collapseRunningThinking(): void {
		const rows = this.openTurn ? this.rowsOf(this.openTurn) : undefined;
		for (const row of rows ?? []) {
			if (row instanceof AssistantMessageComponent) row.setThinkingCollapsed(this.folding);
		}
	}

	/** The rows of a turn, up to the end of the transcript; undefined when its opening row was cleared since. */
	private rowsOf(turn: Turn): Component[] | undefined {
		const from = this.firstRowIndex(turn);
		return from < 0 ? undefined : this.transcript.children.slice(from);
	}

	/** The index of a turn's first row; -1 when its opening row was cleared. */
	private firstRowIndex(turn: Turn): number {
		if (turn.after === undefined) return 0;
		const index = this.transcript.children.indexOf(turn.after);
		return index < 0 ? -1 : index + 1;
	}

	private lastRow(): Component | undefined {
		const children = this.transcript.children;
		return children[children.length - 1];
	}

	/** Whether turns fold. */
	isFolding(): boolean {
		return this.folding;
	}

	/** Fold every turn, or show every turn in full. Folding again closes rows opened one by one. */
	setFolding(folding: boolean): void {
		// Settings are applied again on reload; rows opened one by one stay open unless folding changes.
		if (folding === this.folding) return;
		this.folding = folding;
		for (const child of this.transcript.children) {
			if (child instanceof TurnFoldComponent) child.setFolding(folding);
		}
		this.collapseRunningThinking();
	}

	/** Open or fold the row of the last turn. Returns false when there is no such row to toggle. */
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

/** Whether a row is the turn's reply. */
function isReply(row: Component): row is AssistantMessageComponent {
	return row instanceof AssistantMessageComponent && row.isReply();
}

/** Whether a row of a running turn can fold: not a response being written or the reply, not a tool call that runs. */
function isFinishedActivity(row: Component): boolean {
	if (row instanceof AssistantMessageComponent) return row.isFinished() && !row.isReply();
	if (row instanceof ToolExecutionComponent) return row.isFinished();
	return true;
}

/** Count what a turn did from its rows. */
function summarizeTurn(
	activity: readonly Component[],
	reply: AssistantMessageComponent | undefined,
	startedAt: number,
): TurnSummary {
	let tools = 0;
	let thinking = 0;
	let errors = 0;
	let lastEnd: number | undefined;
	for (const row of reply ? [...activity, reply] : activity) {
		if (row instanceof ToolExecutionComponent) {
			tools++;
			if (row.isError()) errors++;
			const finishedAt = row.getFinishedAt();
			if (finishedAt !== undefined) lastEnd = Math.max(lastEnd ?? finishedAt, finishedAt);
		} else if (row instanceof AssistantMessageComponent) {
			const message = row.getMessage();
			if (!message) continue;
			thinking += message.content.filter((part) => part.type === "thinking" && part.thinking.trim()).length;
			const end = message.timestamp + (message.durationMs ?? 0);
			lastEnd = Math.max(lastEnd ?? end, end);
		}
	}
	const durationMs = lastEnd !== undefined && lastEnd >= startedAt ? lastEnd - startedAt : undefined;
	return { tools, thinking, errors, durationMs };
}

/** The row text without its open/closed glyph, for example `12 tools · 9 thinking · 1:40 · 2 errors`. */
function formatTurnSummary(summary: TurnSummary): string {
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
 * The fold row of one turn, followed by the turn's activity while it is open. With folding off it shows the activity
 * alone, as before folding existed. The reply stays outside, after this component. A running turn adds rows as they
 * finish ({@link absorb}) and gets its reply once it has one ({@link finish}).
 */
export class TurnFoldComponent extends Container {
	private readonly activity = new TranscriptContainer();
	private readonly startedAt: number;
	private reply: AssistantMessageComponent | undefined;
	private readonly header: Component;
	private folding: boolean;
	private open = false;
	private outputPad: number;

	constructor(startedAt: number, folding: boolean, outputPad: number) {
		super();
		this.startedAt = startedAt;
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

	/** Fold more rows of the turn, after the ones folded before. */
	absorb(rows: readonly Component[]): void {
		for (const row of rows) this.activity.addChild(row);
	}

	/** Mark the turn finished with its reply, whose thinking folds with the turn; undefined for a turn cut short. */
	finish(reply: AssistantMessageComponent | undefined): void {
		this.reply = reply;
		this.update();
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

	/** Indent the row like the rest of the transcript. */
	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
	}

	private update(): void {
		this.children = !this.folding ? [this.activity] : this.open ? [this.header, this.activity] : [this.header];
		this.reply?.setActivityFolded(this.folding && !this.open);
	}

	private renderRow(width: number): string {
		const summary = summarizeTurn(this.activity.children, this.reply, this.startedAt);
		const glyph = this.open ? "▾" : "▸";
		const text = formatTurnSummary({ ...summary, errors: 0 });
		const errors = formatTurnSummary({ tools: 0, thinking: 0, durationMs: undefined, errors: summary.errors });
		const errorPart = errors ? theme.fg("error", ` · ${errors}`) : "";
		return truncateToWidth(
			`${" ".repeat(this.outputPad)}${theme.fg("muted", `${glyph} ${text}`)}${errorPart}`,
			width,
		);
	}
}
