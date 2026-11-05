// The handoff of a turn: short text a model wrote about what a turn does, which the turn's fold row shows.

/**
 * The custom entry type of a turn handoff. An extension appends the entry with `pi.appendEntry`; the model never sees
 * it. Its place in the session says which turn it describes: a running handoff belongs to the turn open when it was
 * appended, a finished one to the last turn that folded before it.
 */
export const TURN_HANDOFF_ENTRY_TYPE = "turn-handoff";

/** What a running turn is for, what it has done, and what it does next; its fold row shows them until the reply. */
export interface RunningTurnHandoff {
	kind: "running";
	goal: string;
	done: string;
	next: string;
}

/** One sentence on what a finished turn did; its fold row shows it after the counts. */
export interface FinishedTurnHandoff {
	kind: "finished";
	summary: string;
}

export type TurnHandoff = RunningTurnHandoff | FinishedTurnHandoff;

/** The handoff a custom entry's data holds, or undefined when it holds none, such as a session file edited by hand. */
export function parseTurnHandoff(data: unknown): TurnHandoff | undefined {
	if (typeof data !== "object" || data === null || !("kind" in data)) return undefined;
	if (data.kind === "finished" && "summary" in data && typeof data.summary === "string") {
		return { kind: "finished", summary: data.summary };
	}
	if (
		data.kind === "running" &&
		"goal" in data &&
		typeof data.goal === "string" &&
		"done" in data &&
		typeof data.done === "string" &&
		"next" in data &&
		typeof data.next === "string"
	) {
		return { kind: "running", goal: data.goal, done: data.done, next: data.next };
	}
	return undefined;
}
