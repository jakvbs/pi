// Decides when a turn gets a handoff and which handoffs may still be written, from the turn's steps and the clock.
import type { RunningTurnHandoff } from "@earendil-works/pi-coding-agent";

/** One tool call of a step, as text for the handoff model. */
export interface ToolCallRecord {
	name: string;
	args: string;
	result: string;
	isError: boolean;
}

/** One step of a turn: one response of the agent and the results of the tool calls it made. */
export interface Step {
	/** When the step ended, in ms since the epoch. */
	at: number;
	thinking: string;
	text: string;
	calls: ToolCallRecord[];
}

/** What the handoff model gets: the turn's goal, its previous handoff and the steps since. */
export type HandoffRequest =
	| { id: number; kind: "running"; goal: string; previous: RunningTurnHandoff | undefined; steps: Step[] }
	| { id: number; kind: "finished"; goal: string; previous: RunningTurnHandoff; steps: Step[]; reply: string };

/** How often a running turn gets a handoff. */
export interface Cadence {
	/** A handoff is due this long after the previous one, or after the turn started, once a step has ended. */
	everyMs: number;
	/** A handoff is due after this many tool calls since the previous one. */
	everyToolCalls: number;
}

/** A turn that runs: the steps no written handoff covers yet, and the request that is out, if any. */
interface OpenTurn {
	goal: string;
	previous: RunningTurnHandoff | undefined;
	/** When the previous handoff was written, or a failed request returned, or the turn started. */
	since: number;
	steps: Step[];
	toolCallsSince: number;
	pending: { id: number; steps: number; toolCalls: number } | undefined;
}

/**
 * Tracks the turn that runs. A turn gets a running handoff at the end of a step once the cadence is due and no request
 * is out, and a finished handoff at its reply when it had a running one; a short turn gets none. A handoff may be
 * written only while it still describes the turn that pi shows it in: a running one while its turn runs, a finished
 * one until another turn ends.
 */
export class TurnTracker {
	private readonly cadence: Cadence;
	private goal = "";
	private turn: OpenTurn | undefined;
	private nextId = 1;
	/** Counts ended turns; a finished request remembers it, so a later end makes its handoff stale. */
	private ended = 0;
	private readonly finishedAt = new Map<number, number>();

	constructor(cadence: Cadence) {
		this.cadence = cadence;
	}

	/** A user message: it ends the turn that runs, if any, and opens the next one with the message as the goal. */
	userMessage(text: string, now: number): void {
		this.end();
		this.goal = text;
		this.turn = this.openTurn(now);
	}

	/** A run starts; it continues the open turn or opens one with the last goal, as a retry or an extension's run does. */
	runStarted(now: number): void {
		this.turn ??= this.openTurn(now);
	}

	/** A step that called tools ended; returns the running request to send when a handoff is due. */
	step(step: Step, now: number): HandoffRequest | undefined {
		const turn = this.turn;
		if (!turn) return undefined;
		turn.steps.push(step);
		turn.toolCallsSince += step.calls.length;
		const due = turn.toolCallsSince >= this.cadence.everyToolCalls || now - turn.since >= this.cadence.everyMs;
		if (turn.pending || !due) return undefined;
		const id = this.nextId++;
		turn.pending = { id, steps: turn.steps.length, toolCalls: turn.toolCallsSince };
		return { id, kind: "running", goal: turn.goal, previous: turn.previous, steps: [...turn.steps] };
	}

	/**
	 * The reply ended the turn; returns the finished request when the turn had a running handoff. Steps a running
	 * request is still out for go into it too, since that request's handoff can no longer be written.
	 */
	reply(step: Step): HandoffRequest | undefined {
		const turn = this.turn;
		this.end();
		if (!turn?.previous) return undefined;
		const id = this.nextId++;
		this.finishedAt.set(id, this.ended);
		const steps = [...turn.steps, step];
		return { id, kind: "finished", goal: turn.goal, previous: turn.previous, steps, reply: step.text };
	}

	/** The run ended without a reply, for example on an error or an abort; the turn gets no finished handoff. */
	runEnded(): void {
		this.end();
	}

	/**
	 * A request returned a handoff; returns whether it may be written. A running handoff becomes the previous one and
	 * the steps it covers leave the turn.
	 */
	written(request: HandoffRequest, handoff: RunningTurnHandoff | undefined, now: number): boolean {
		if (request.kind === "finished") {
			const ended = this.finishedAt.get(request.id);
			this.finishedAt.delete(request.id);
			return ended === this.ended;
		}
		const turn = this.turn;
		const pending = turn?.pending;
		if (!turn || pending?.id !== request.id || !handoff) return false;
		turn.steps.splice(0, pending.steps);
		turn.toolCallsSince -= pending.toolCalls;
		turn.previous = handoff;
		turn.since = now;
		turn.pending = undefined;
		return true;
	}

	/** A request failed; the next try waits a full cadence and covers its steps too. */
	failed(request: HandoffRequest, now: number): void {
		this.finishedAt.delete(request.id);
		const turn = this.turn;
		if (turn?.pending?.id !== request.id) return;
		turn.pending = undefined;
		turn.since = now;
		turn.toolCallsSince = 0;
	}

	/** The id of the running request that is out, which a turn end makes stale. */
	pendingId(): number | undefined {
		return this.turn?.pending?.id;
	}

	private openTurn(now: number): OpenTurn {
		return { goal: this.goal, previous: undefined, since: now, steps: [], toolCallsSince: 0, pending: undefined };
	}

	private end(): void {
		if (!this.turn) return;
		this.turn = undefined;
		this.ended++;
	}
}
