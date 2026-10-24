import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type EntryLookup = (id: string) => SessionEntry | undefined;

type ContentBlock = { type: string; text?: string };

/** A response ends its run unless it asked for tools or failed (an automatic retry can follow an error). */
export function endsRun(stopReason: string): boolean {
	return stopReason !== "toolUse" && stopReason !== "error";
}

/**
 * Start of the run containing `fromId`, read from the session tree alone so it works for sessions
 * recorded before this extension existed. Walks toward the root until the previous run's final
 * response and returns the earliest user message on the way; a run without one (started by an
 * extension) falls back to the earliest custom message. An error is that final response when a later
 * message already started a new run; otherwise it was retried within this run.
 */
export function runStart(fromId: string | null, getEntry: EntryLookup): number | undefined {
	let user: number | undefined;
	let custom: number | undefined;
	let entry = fromId ? getEntry(fromId) : undefined;
	while (entry && entry.type !== "branch_summary") {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user") user = message.timestamp;
			else if (message.role === "assistant") {
				const newerRunStarted = (user ?? custom) !== undefined;
				if (endsRun(message.stopReason) || (message.stopReason === "error" && newerRunStarted)) break;
			}
		} else if (entry.type === "custom_message") {
			custom = Date.parse(entry.timestamp);
		}
		entry = entry.parentId ? getEntry(entry.parentId) : undefined;
	}
	return user ?? custom;
}

/** Duration of the run a final response closes. The entry is appended right after the response completes. */
export function runDuration(entry: SessionEntry, getEntry: EntryLookup): number | undefined {
	if (entry.type !== "message" || entry.message.role !== "assistant" || !endsRun(entry.message.stopReason)) {
		return undefined;
	}
	const start = runStart(entry.parentId, getEntry);
	// Wall-clock corrections can move a later entry before an earlier one.
	return start === undefined ? undefined : Math.max(0, Date.parse(entry.timestamp) - start);
}

export function userText(content: string | readonly ContentBlock[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

/** The interactive transcript renders each trimmed text block separately; the stamp goes after the last one. */
export function lastText(content: readonly ContentBlock[]): string | undefined {
	for (let index = content.length - 1; index >= 0; index -= 1) {
		const block = content[index];
		const text = block?.type === "text" ? block.text?.trim() : undefined;
		if (text) return text;
	}
	return undefined;
}

const pad2 = (value: number): string => value.toString().padStart(2, "0");

export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = pad2(total % 60);
	return hours > 0 ? `${hours}:${pad2(minutes)}:${seconds}` : `${minutes}:${seconds}`;
}

/** Local time of day; earlier days also get their date, since resumed sessions span days. */
export function formatClock(ms: number, now: number): string {
	const date = new Date(ms);
	const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
	if (date.toDateString() === new Date(now).toDateString()) return time;
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
}

export function responseLabel(completedAt: number, runMs: number | undefined, now: number): string {
	const clock = formatClock(completedAt, now);
	return runMs === undefined ? clock : `${clock} · ${formatDuration(runMs)}`;
}

/**
 * Appends a right-aligned stamp line to Markdown. Markdown keeps ANSI styling and spacing only inside a
 * code span, so the line is one code span padded with non-breaking spaces. Labels are ASCII plus "·",
 * so their length equals their terminal width.
 */
export function appendStamp(markdown: string, label: string, width: number, style: (text: string) => string): string {
	const padding = "\u00a0".repeat(Math.max(0, width - label.length));
	return `${markdown}\n\n\`${padding}${style(label)}\``;
}
