// Folds the activity of each finished turn (thinking, tool calls, commentary) into one row between the user message
// and the reply.
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

/** Where a turn's rows lie in the transcript: after its opening rows, up to its last row once it has finished. */
interface Turn {
	/** The last row of the opener; undefined when the turn opened at the top of the transcript. */
	after: Component | undefined;
	startedAt: number;
}

/** A finished turn that still shows in full, up to its last row. */
interface FinishedTurn extends Turn {
	last: Component;
}

/**
 * Tracks the turns of a transcript and folds them when the owner acts. A turn starts after a row that opens it (a user
 * message, a `!` command, a compaction or branch-summary marker, an extension message after a finished reply). A
 * finished turn stays in full until {@link TurnFolds.end}, which the next user message or `!` command calls, so the
 * layout changes only on the owner's action; a read-only view, which has no owner's actions, folds a turn as soon as
 * its reply arrives ({@link TurnFolds.endAnswered}). Its reply is the last assistant message whose stop reason is not
 * `toolUse`; everything else the turn added folds into one row above the reply, except extension messages (notices
 * that stay visible in their place) and rows the reply is followed by that are not tool calls (notices about the reply).
 */
export class TurnFolds {
	private readonly transcript: Container;
	private folding: boolean;
	private outputPad: number;
	private openTurn: Turn | undefined;
	/** Turns that finished since the owner last acted, oldest first; they fold with the open turn. */
	private finished: FinishedTurn[] = [];

	constructor(transcript: Container, folding: boolean, outputPad: number) {
		this.transcript = transcript;
		this.folding = folding;
		this.outputPad = outputPad;
	}

	/** Open a turn after the transcript's current last row. */
	start(startedAt: number): void {
		this.openTurn = { after: this.lastRow(), startedAt };
	}

	/**
	 * Open a turn at a row that continues a turn already folded without a row to open it, such as a retry after a
	 * failed reply in a view. Does nothing while a turn is open.
	 */
	resume(startedAt: number): void {
		if (!this.openTurn) this.start(startedAt);
	}

	/**
	 * Fold every finished turn, and the open turn once its reply has arrived. A view calls this at each reply, because
	 * it never gets the owner's next message that {@link end} waits for.
	 */
	endAnswered(): void {
		if (this.awaitsReply()) this.foldFinished();
		else this.end();
	}

	/** Count the rows added since the open turn started as part of the row that opened it, such as its cost notice. */
	keepWithOpener(): void {
		if (this.openTurn) this.openTurn.after = this.lastRow();
	}

	/** Whether a turn is open and still waits for its reply, so a message from an extension belongs inside it. */
	awaitsReply(): boolean {
		const rows = this.openTurn ? this.rowsOf(this.openTurn, undefined) : undefined;
		return rows !== undefined && !rows.some(isReply);
	}

	/** Forget every turn without folding it, for a transcript that is about to be rebuilt. */
	reset(): void {
		this.openTurn = undefined;
		this.finished = [];
	}

	/** Close the open turn without folding it, before a row that opens the next turn; it folds at the next {@link end}. */
	finish(): void {
		const turn = this.openTurn;
		const last = this.lastRow();
		// A turn without rows has nothing to fold.
		if (turn && last && last !== turn.after) this.finished.push({ ...turn, last });
		this.openTurn = undefined;
	}

	/**
	 * Fold the open turn and every turn finished since the last call. A turn without tool calls and thinking keeps its
	 * rows and gets no fold row.
	 */
	end(): void {
		const open = this.openTurn;
		this.openTurn = undefined;
		// The latest first, so the rows of an earlier turn keep their place while a later one is spliced.
		if (open) this.fold(open, undefined);
		this.foldFinished();
	}

	/** Fold every turn finished since the last call, the latest first. */
	private foldFinished(): void {
		const finished = this.finished;
		this.finished = [];
		for (const turn of finished.reverse()) this.fold(turn, turn.last);
	}

	/** Replace the rows of one turn, up to `last` or the end of the transcript, with its fold row and visible rows. */
	private fold(turn: Turn, last: Component | undefined): void {
		const rows = this.rowsOf(turn, last);
		if (!rows) return;

		const reply = rows.findLast(isReply);
		const replyIndex = reply ? rows.lastIndexOf(reply) : -1;
		const folds = (row: Component, index: number): boolean =>
			index !== replyIndex &&
			!(row instanceof CustomMessageComponent) &&
			(replyIndex < 0 || index < replyIndex || row instanceof ToolExecutionComponent);
		const activity = rows.filter(folds);
		const summary = summarizeTurn(activity, reply, turn.startedAt);
		if (summary.tools === 0 && summary.thinking === 0) return;

		// The row takes the place of the first row it folds, or of the reply if that comes first; the rest keep order.
		const fold = new TurnFoldComponent(activity, reply, summary, this.folding, this.outputPad);
		const shown: Component[] = [];
		let placed = false;
		rows.forEach((row, index) => {
			const folded = folds(row, index);
			if (!placed && (folded || index === replyIndex)) {
				shown.push(fold);
				placed = true;
			}
			if (!folded) shown.push(row);
		});
		this.transcript.children.splice(this.firstRowIndex(turn), rows.length, ...shown);
	}

	/**
	 * The rows of a turn up to `last`, or to the end of the transcript without it; undefined when its opening row or
	 * its last row was cleared since.
	 */
	private rowsOf(turn: Turn, last: Component | undefined): Component[] | undefined {
		const children = this.transcript.children;
		const from = this.firstRowIndex(turn);
		if (from < 0) return undefined;
		if (last === undefined) return children.slice(from);
		const to = children.indexOf(last) + 1;
		return to > from ? children.slice(from, to) : undefined;
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

	/** Whether finished turns fold. */
	isFolding(): boolean {
		return this.folding;
	}

	/** Fold every finished turn, or show every turn in full. Folding again closes rows opened one by one. */
	setFolding(folding: boolean): void {
		// Settings are applied again on reload; rows opened one by one stay open unless folding changes.
		if (folding === this.folding) return;
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

/** Whether a row is the turn's reply. */
function isReply(row: Component): row is AssistantMessageComponent {
	return row instanceof AssistantMessageComponent && row.isReply();
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

	/** Indent the row like the rest of the transcript. */
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
