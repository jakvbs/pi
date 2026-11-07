// Folds the activity of each turn (thinking, tool calls) into rows between the user message and the reply, also while
// the turn runs. Commentary the model wrote between tool calls ends one part of the turn and stays visible below its row.
import {
	type Component,
	Container,
	type TuiMouseEvent,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { RunningTurnHandoff, TurnHandoff } from "../../../core/turn-handoff.ts";
import { theme } from "../theme/theme.ts";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { CustomMessageComponent } from "./custom-message.ts";
import { formatUsage, type StepUsage, sumUsage } from "./step-usage.ts";
import { ToolExecutionComponent, TranscriptContainer } from "./tool-execution.ts";

/** What a part of a turn, or a whole turn, did, as its row shows it. */
export interface TurnSummary {
	tools: number;
	/** Non-empty thinking blocks, also the reply's. */
	thinking: number;
	/** Tool calls that ended with an error. */
	errors: number;
	/**
	 * From the start to the end of the last response or tool result, whichever is later; undefined without a response.
	 */
	durationMs: number | undefined;
	/** What the steps added to the context window and cost, from the usage set on their rows. */
	usage: StepUsage;
}

/** Where a turn's rows lie in the transcript: after its opening rows, up to the end of the transcript. */
interface Turn {
	/** The last row of the opener; undefined when the turn opened at the top of the transcript. */
	after: Component | undefined;
	startedAt: number;
	/** The parts the turn folded into so far, in order; only the last one takes more rows, unless commentary closed it. */
	parts: TurnFoldComponent[];
	/** The latest handoff of the running turn, which its last part shows. */
	handoff: RunningTurnHandoff | undefined;
}

/**
 * Tracks the open turn of a transcript and folds it as soon as its reply arrives ({@link TurnFolds.end}). A turn starts
 * after a row that opens it (a user message, a `!` command, a compaction or branch-summary marker, an extension message
 * after a reply), or at an assistant message that follows a folded turn without such a row, such as an automatic retry
 * after a failed reply. Its reply is the last assistant message whose stop reason is not `toolUse`; everything else the
 * turn added folds above the reply, except extension messages (notices that stay visible in their place) and rows the
 * reply is followed by that are not tool calls (notices about the reply).
 *
 * The turn folds into parts, each one row. Commentary, a response that wrote text and then called tools, ends its part
 * and shows below the part's row; the rows after it start the next part. The reply's thinking counts in the last part.
 *
 * While the turn runs, its finished rows fold into its parts as they finish ({@link TurnFolds.foldFinished}), so only
 * the rows and commentary of its parts and what still runs show: the response being written, with the last lines of its
 * thinking, and the tool calls that have no result yet.
 *
 * A handoff ({@link TurnFolds.setHandoff}) adds what a model wrote about the turn to a row of the turn.
 */
export class TurnFolds {
	private readonly transcript: Container;
	private folding: boolean;
	private outputPad: number;
	private openTurn: Turn | undefined;
	/** The last part of the turn that folded last, which a finished handoff describes. */
	private lastFold: TurnFoldComponent | undefined;

	constructor(transcript: Container, folding: boolean, outputPad: number) {
		this.transcript = transcript;
		this.folding = folding;
		this.outputPad = outputPad;
	}

	/** Open a turn after the transcript's current last row. */
	start(startedAt: number): void {
		this.openTurn = { after: this.lastRow(), startedAt, parts: [], handoff: undefined };
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
		this.lastFold = undefined;
	}

	/**
	 * Fold the open turn, at its reply or before a row that opens the next turn. A turn without tool calls and thinking
	 * gets no row.
	 */
	end(): void {
		const open = this.openTurn;
		this.openTurn = undefined;
		if (open) this.lastFold = this.fold(open);
	}

	/**
	 * Show a handoff in a row of the turn it describes: a running one in the last part of the open turn until its reply,
	 * a finished one in the last part of the turn that folded last.
	 */
	setHandoff(handoff: TurnHandoff): void {
		if (handoff.kind === "finished") {
			this.lastFold?.setHandoff(handoff);
		} else if (this.openTurn) {
			this.openTurn.handoff = handoff;
			this.openTurn.parts.at(-1)?.setHandoff(handoff);
		}
	}

	/**
	 * Fold the rows of the open turn that have finished, in order up to the first one still running: responses that
	 * called tools, tool calls with their result, notices. A part gets its row with its first tool call or thinking.
	 */
	foldFinished(): void {
		const turn = this.openTurn;
		const rows = turn ? this.rowsOf(turn) : undefined;
		if (!turn || !rows) return;

		const finished: Component[] = [];
		for (const row of rows) {
			if (row instanceof TurnFoldComponent || row instanceof CustomMessageComponent) continue;
			if (!isFinishedActivity(row)) break;
			finished.push(row);
		}
		this.absorb(turn, rows, finished, undefined);
		this.showRunning();
	}

	/** Fold the rows of one turn into its parts before its reply; returns the last part, or undefined without one. */
	private fold(turn: Turn): TurnFoldComponent | undefined {
		const rows = this.rowsOf(turn);
		if (!rows) return undefined;

		const reply = rows.findLast(isReply);
		const replyIndex = reply ? rows.lastIndexOf(reply) : -1;
		const activity = rows.filter(
			(row, index) =>
				!(row instanceof TurnFoldComponent) &&
				!(row instanceof CustomMessageComponent) &&
				index !== replyIndex &&
				(replyIndex < 0 || index < replyIndex || row instanceof ToolExecutionComponent),
		);
		for (const row of rows) if (row instanceof AssistantMessageComponent) row.setPlace("full");
		this.absorb(turn, rows, activity, reply);

		const last = turn.parts.at(-1);
		if (!last) return undefined;
		last.finish(reply);
		if (reply && turn.parts.filter((part) => part.hasRow()).length > 1) {
			const activityRows = () => turn.parts.flatMap((part) => part.getActivityRows());
			reply.setTurnSummary(
				() => `Σ ${formatTurnSummary(summarizeTurn(activityRows(), reply, turn.startedAt), true)}`,
			);
		}
		return last;
	}

	/**
	 * Fold rows of a turn into its parts, in order. The last part takes rows until commentary closes it; the rows after
	 * commentary start a new part, which takes the place of its first row, or of the reply when that comes first. A reply
	 * with thinking gets a part of its own when no part takes rows, since its thinking counts in the last part.
	 */
	private absorb(
		turn: Turn,
		rows: readonly Component[],
		activity: readonly Component[],
		reply: AssistantMessageComponent | undefined,
	): void {
		const last = turn.parts.at(-1);
		let startedAt = last?.endedAt() ?? turn.startedAt;
		const continued = last && !last.isClosed() ? { part: last, rows: [] as Component[] } : undefined;
		let open = continued;
		const created: { part: TurnFoldComponent; rows: Component[] }[] = [];
		const startPart = () => {
			const group = { part: new TurnFoldComponent(startedAt, this.folding, this.outputPad), rows: [] };
			created.push(group);
			return group;
		};
		for (const row of activity) {
			open ??= startPart();
			open.rows.push(row);
			if (isCommentary(row)) {
				startedAt = messageEnd(row) ?? startedAt;
				open = undefined;
			}
		}
		if (!open && reply && hasThinking(reply)) startPart();
		if (activity.length === 0 && created.length === 0) return;

		const folded = new Set(activity);
		const replyIndex = reply ? rows.indexOf(reply) : -1;
		const anchoredAt = (group: { rows: Component[] }): number => {
			const first = group.rows.length > 0 ? rows.indexOf(group.rows[0]) : replyIndex;
			return replyIndex >= 0 && first > replyIndex ? replyIndex : first;
		};
		const shown = rows.flatMap((row, index) => [
			...created.filter((group) => anchoredAt(group) === index).map((group) => group.part),
			...(folded.has(row) ? [] : [row]),
		]);
		this.transcript.children.splice(this.firstRowIndex(turn), rows.length, ...shown);
		if (continued) continued.part.absorb(continued.rows);
		for (const group of created) group.part.absorb(group.rows);

		if (created.length === 0) return;
		turn.parts.at(-1)?.setHandoff(undefined);
		turn.parts.push(...created.map((group) => group.part));
		turn.parts.at(-1)?.setHandoff(turn.handoff);
	}

	/** Show the thinking of the open turn's running response by its last lines while the turn folds. */
	private showRunning(): void {
		const rows = this.openTurn ? this.rowsOf(this.openTurn) : undefined;
		for (const row of rows ?? []) {
			if (row instanceof AssistantMessageComponent) row.setPlace(this.folding ? "live" : "full");
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
		this.showRunning();
	}

	/** Open or fold the last row of the transcript. Returns false when there is no such row to toggle. */
	toggleLast(): boolean {
		if (!this.folding) return false;
		const last = this.transcript.children.findLast(
			(child): child is TurnFoldComponent => child instanceof TurnFoldComponent && child.hasRow(),
		);
		last?.toggle();
		return last !== undefined;
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

/**
 * Whether a row is commentary: a response with text that also called tools, such as a progress report between steps.
 * It ends a part of a folded turn and stays visible below the part's row.
 */
function isCommentary(row: Component): row is AssistantMessageComponent {
	return (
		row instanceof AssistantMessageComponent &&
		(row.getMessage()?.content.some((part) => part.type === "text" && part.text.trim() !== "") ?? false)
	);
}

function hasThinking(row: AssistantMessageComponent): boolean {
	return row.getMessage()?.content.some((part) => part.type === "thinking" && part.thinking.trim() !== "") ?? false;
}

/** When a message's response ended, in ms since the epoch; undefined before it has one. */
function messageEnd(row: AssistantMessageComponent): number | undefined {
	const message = row.getMessage();
	return message ? message.timestamp + (message.durationMs ?? 0) : undefined;
}

/** Whether a row of a running turn can fold: not a response being written or the reply, not a tool call that runs. */
function isFinishedActivity(row: Component): boolean {
	if (row instanceof AssistantMessageComponent) return row.isFinished() && !row.isReply();
	if (row instanceof ToolExecutionComponent) return row.isFinished();
	return true;
}

/** Count what a part of a turn, or a whole turn, did from its rows. */
function summarizeTurn(
	activity: readonly Component[],
	reply: AssistantMessageComponent | undefined,
	startedAt: number,
): TurnSummary {
	let tools = 0;
	let thinking = 0;
	let errors = 0;
	let lastEnd: number | undefined;
	const steps: StepUsage[] = [];
	for (const row of reply ? [...activity, reply] : activity) {
		if (row instanceof ToolExecutionComponent || row instanceof AssistantMessageComponent) {
			const usage = row.getStepUsage();
			if (usage) steps.push(usage);
		}
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
	return { tools, thinking, errors, durationMs, usage: sumUsage(steps) };
}

/**
 * The row text without its open/closed glyph, for example `12 tools · 9 thinking · 1:40 · +38k ctx · $1.204`, with
 * `· 2 errors` at the end when errors are asked for.
 */
function formatTurnSummary(summary: TurnSummary, withErrors: boolean): string {
	const parts: string[] = [];
	if (summary.tools > 0) parts.push(`${summary.tools} ${summary.tools === 1 ? "tool" : "tools"}`);
	if (summary.thinking > 0) parts.push(`${summary.thinking} thinking`);
	if (summary.durationMs !== undefined) parts.push(formatDuration(summary.durationMs));
	const usage = formatUsage(summary.usage);
	if (usage) parts.push(usage);
	if (withErrors && summary.errors > 0) parts.push(formatErrors(summary.errors));
	return parts.join(" · ");
}

function formatErrors(errors: number): string {
	return `${errors} ${errors === 1 ? "error" : "errors"}`;
}

function formatDuration(durationMs: number): string {
	const totalSeconds = Math.round(durationMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = String(totalSeconds % 60).padStart(2, "0");
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * One part of a turn: its row, followed by the part's activity while it is open, or by the commentary that ends the
 * part while it is folded. With folding off, or without a tool call or thinking to count, it shows the activity alone,
 * as before folding existed. The reply stays outside, after the turn's last part. A running turn adds rows to its last
 * part as they finish ({@link absorb}) and gives that part its reply once it has one ({@link finish}).
 */
export class TurnFoldComponent extends Container {
	private readonly activity = new TranscriptContainer();
	private readonly startedAt: number;
	private reply: AssistantMessageComponent | undefined;
	private handoff: TurnHandoff | undefined;
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
			render: (width) => ["", this.renderRow(width), ...this.renderHandoff(width)],
			handleMouse: (event: TuiMouseEvent) => {
				if (event.y !== 1 || event.type !== "click" || event.button !== "left") return undefined;
				this.toggle();
				return { handled: true };
			},
			invalidate: () => {},
		};
		this.update();
	}

	/** The rows folded into this part. */
	getActivityRows(): readonly Component[] {
		return this.activity.children;
	}

	/** Fold more rows of the turn into this part, after the ones folded before. */
	absorb(rows: readonly Component[]): void {
		for (const row of rows) this.activity.addChild(row);
		this.update();
	}

	/**
	 * Mark this last part of a turn finished with the turn's reply, whose thinking it counts; undefined for a turn cut
	 * short. A running handoff goes, because the reply says what the turn did.
	 */
	finish(reply: AssistantMessageComponent | undefined): void {
		this.reply = reply;
		if (this.handoff?.kind === "running") this.handoff = undefined;
		this.update();
	}

	/** Show what a model wrote about the turn, or nothing. */
	setHandoff(handoff: TurnHandoff | undefined): void {
		this.handoff = handoff;
	}

	/** Whether commentary ended this part, so the turn's next rows start another one. */
	isClosed(): boolean {
		const last = this.activity.children.at(-1);
		return last !== undefined && isCommentary(last);
	}

	/** When the commentary that ended this part was written; undefined while the part takes more rows. */
	endedAt(): number | undefined {
		const last = this.activity.children.at(-1);
		return last && isCommentary(last) ? messageEnd(last) : undefined;
	}

	/** Whether this part has a row: it counts a tool call or thinking. */
	hasRow(): boolean {
		const { tools, thinking } = this.summary();
		return tools > 0 || thinking > 0;
	}

	/** Open or fold this part. Does nothing while folding is off or without a row. */
	toggle(): void {
		if (!this.folding || !this.hasRow()) return;
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

	private summary(): TurnSummary {
		return summarizeTurn(this.activity.children, this.reply, this.startedAt);
	}

	private update(): void {
		const folds = this.folding && this.hasRow();
		const folded = folds && !this.open;
		const last = this.activity.children.at(-1);
		const commentary = last && isCommentary(last) ? last : undefined;
		this.children = !folds
			? [this.activity]
			: this.open
				? [this.header, this.activity]
				: [this.header, ...(commentary ? [commentary] : [])];
		for (const row of this.activity.children) {
			if (row instanceof AssistantMessageComponent) row.setPlace(folded && row === commentary ? "folded" : "full");
		}
		this.reply?.setPlace(folded ? "folded" : "full");
	}

	private renderRow(width: number): string {
		const summary = this.summary();
		const glyph = this.open ? "▾" : "▸";
		const errorPart = summary.errors > 0 ? theme.fg("error", ` · ${formatErrors(summary.errors)}`) : "";
		const summaryPart =
			this.handoff?.kind === "finished" && !this.open ? theme.fg("dim", ` · ${this.handoff.summary}`) : "";
		return truncateToWidth(
			`${" ".repeat(this.outputPad)}${theme.fg("muted", `${glyph} ${formatTurnSummary(summary, false)}`)}${errorPart}${summaryPart}`,
			width,
		);
	}

	/**
	 * The lines below the row: a running handoff in three lines cut to the width, so the row keeps its height while
	 * the handoff changes; a finished one in full while the part is open, since the row cuts it.
	 */
	private renderHandoff(width: number): string[] {
		const indent = " ".repeat(this.outputPad + 2);
		if (this.handoff?.kind === "running") {
			const { goal, done, next } = this.handoff;
			return [`◇ ${goal}`, `✓ ${done}`, `→ ${next}`].map((line) =>
				truncateToWidth(indent + theme.fg("dim", line), width),
			);
		}
		if (this.handoff?.kind === "finished" && this.open) {
			return wrapTextWithAnsi(this.handoff.summary, Math.max(1, width - indent.length)).map(
				(line) => indent + theme.fg("dim", line),
			);
		}
		return [];
	}
}
