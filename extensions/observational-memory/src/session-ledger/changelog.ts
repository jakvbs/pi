import { branchLedger } from "./ledger.ts";
import { observationToSummaryLine, reflectionToSummaryLine } from "./render-summary.ts";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
	type Observation,
	type Reflection,
} from "./types.ts";

type ChangeOrigin = { entryId: string; timestamp?: string };

/**
 * What one entry of the branch ledger (`branchLedger`) changed. First valid
 * record wins, so an entry that only repeats known ids changes nothing.
 */
export type MemoryChange =
	| (ChangeOrigin & { kind: "observed"; observations: Observation[] })
	| (ChangeOrigin & { kind: "reflected"; reflections: Reflection[] })
	| (ChangeOrigin & { kind: "dropped"; observations: Observation[]; unknownIds: string[] });

/** Memory changes on the branch, oldest first. */
export function memoryChangelog(entries: Entry[]): MemoryChange[] {
	const observationsById = new Map<string, Observation>();
	const reflectionIds = new Set<string>();
	const droppedIds = new Set<string>();
	const changes: MemoryChange[] = [];

	for (const { entry } of branchLedger(entries)) {
		const origin = { entryId: entry.id, timestamp: entry.timestamp };
		switch (entry.customType) {
			case OM_OBSERVATIONS_RECORDED: {
				const added = entry.data.observations.filter((observation) => !observationsById.has(observation.id));
				for (const observation of added) observationsById.set(observation.id, observation);
				if (added.length > 0) changes.push({ ...origin, kind: "observed", observations: added });
				break;
			}
			case OM_REFLECTIONS_RECORDED: {
				const added = entry.data.reflections.filter((reflection) => !reflectionIds.has(reflection.id));
				for (const reflection of added) reflectionIds.add(reflection.id);
				if (added.length > 0) changes.push({ ...origin, kind: "reflected", reflections: added });
				break;
			}
			case OM_OBSERVATIONS_DROPPED: {
				const ids = [...new Set(entry.data.observationIds)].filter((id) => !droppedIds.has(id));
				for (const id of ids) droppedIds.add(id);
				const observations = ids.flatMap((id) => observationsById.get(id) ?? []);
				const unknownIds = ids.filter((id) => !observationsById.has(id));
				if (ids.length > 0) changes.push({ ...origin, kind: "dropped", observations, unknownIds });
				break;
			}
		}
	}
	return changes;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function changeTimestamp(change: MemoryChange): string {
	return change.timestamp ? `${change.timestamp.slice(0, 16).replace("T", " ")} UTC` : "unknown time";
}

/** One line naming the stage and the size of the change, e.g. `observer +3 observations`. */
export function changeHeadline(change: MemoryChange): string {
	switch (change.kind) {
		case "observed":
			return `observer +${plural(change.observations.length, "observation")}`;
		case "reflected":
			return `reflector +${plural(change.reflections.length, "reflection")}`;
		case "dropped":
			return `dropper −${plural(change.observations.length + change.unknownIds.length, "observation")}`;
	}
}

/** The memory records the change added or removed, one summary line each. */
export function changeItems(change: MemoryChange): string[] {
	switch (change.kind) {
		case "observed":
			return change.observations.map(observationToSummaryLine);
		case "reflected":
			return change.reflections.map(reflectionToSummaryLine);
		case "dropped":
			return [...change.observations.map(observationToSummaryLine), ...change.unknownIds.map((id) => `[${id}] (not recorded on this branch)`)];
	}
}

function changeContents(change: MemoryChange): string[] {
	switch (change.kind) {
		case "observed":
			return change.observations.map((observation) => observation.content);
		case "reflected":
			return change.reflections.map((reflection) => reflection.content);
		case "dropped":
			return [...change.observations.map((observation) => observation.content), ...change.unknownIds];
	}
}

function preview(text: string, maxChars: number): string {
	const line = text.split("\n", 1)[0].trim();
	return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

/** Headline plus the first few records, shortened, for a notification. */
export function changePreview(change: MemoryChange, maxItems = 3, maxChars = 120): string {
	const contents = changeContents(change);
	const lines = [changeHeadline(change), ...contents.slice(0, maxItems).map((content) => `  • ${preview(content, maxChars)}`)];
	if (contents.length > maxItems) lines.push(`  … ${contents.length - maxItems} more`);
	return lines.join("\n");
}
