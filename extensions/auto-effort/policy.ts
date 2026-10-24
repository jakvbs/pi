import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Custom message that changes the effort of the rest of a run. Its `details` is an {@link EffortChange}. */
export const EFFORT_MESSAGE = "auto-effort";

/** Consecutive turns with a failing tool call that raise the effort one step. */
export const FAILING_TURNS_TO_RAISE = 3;

export interface EffortChange {
	level: ModelThinkingLevel;
	reason: string;
}

const LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return LEVELS.some((level) => level === value);
}

function changedLevel(entry: SessionEntry): ModelThinkingLevel | undefined {
	if (entry.type !== "custom_message" || entry.customType !== EFFORT_MESSAGE) return undefined;
	const details = entry.details;
	if (typeof details !== "object" || details === null || !("level" in details)) return undefined;
	return isThinkingLevel(details.level) ? details.level : undefined;
}

function isUserMessage(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

/**
 * Effort for the next request: the latest change since the last user message, else the selected
 * level. Every user message therefore starts again from the level the user selected.
 */
export function activeLevel(branch: readonly SessionEntry[], selected: ModelThinkingLevel): ModelThinkingLevel {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (isUserMessage(entry)) return selected;
		const level = changedLevel(entry);
		if (level !== undefined) return level;
	}
	return selected;
}

/**
 * Number of consecutive turns, counted back from the latest, in which at least one tool call failed.
 * Counting stops at the last user message or effort change, so each change needs a new streak.
 */
export function failingTurnStreak(branch: readonly SessionEntry[]): number {
	let streak = 0;
	let turnFailed = false;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (isUserMessage(entry) || changedLevel(entry) !== undefined) break;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult" && message.isError) turnFailed = true;
		if (message.role === "assistant") {
			if (!turnFailed) break;
			streak++;
			turnFailed = false;
		}
	}
	return streak;
}

/** The next supported level above `level`, or undefined at the top. */
export function raise(level: ModelThinkingLevel, supported: readonly ModelThinkingLevel[]): ModelThinkingLevel | undefined {
	return supported.find((candidate) => LEVELS.indexOf(candidate) > LEVELS.indexOf(level));
}
