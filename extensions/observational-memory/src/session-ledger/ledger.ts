import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	isNonEmptyString,
	isNonEmptyStringArray,
	isObservation,
	isReflection,
	type Entry,
	type ObservationsDroppedEntryData,
	type ObservationsRecordedEntryData,
	type ReflectionsRecordedEntryData,
} from "./types.ts";

type LedgerCustomEntry<Type extends string, Data> = Entry & { type: "custom"; customType: Type; data: Data };

export type ObservationsRecordedEntry = LedgerCustomEntry<typeof OM_OBSERVATIONS_RECORDED, ObservationsRecordedEntryData>;
export type ReflectionsRecordedEntry = LedgerCustomEntry<typeof OM_REFLECTIONS_RECORDED, ReflectionsRecordedEntryData>;
export type ObservationsDroppedEntry = LedgerCustomEntry<typeof OM_OBSERVATIONS_DROPPED, ObservationsDroppedEntryData>;
export type LedgerEntry = ObservationsRecordedEntry | ReflectionsRecordedEntry | ObservationsDroppedEntry;

export type BranchLedgerEntry = {
	entry: LedgerEntry;
	/** Branch index of the ledger entry itself. */
	index: number;
	/** Branch index of the entry its `coversUpToId` marker names. */
	coverageIndex: number;
};

/**
 * The memory ledger of one branch, in branch order: every valid V3 entry whose
 * coverage marker is on that branch. This is the only reader of raw `om.*`
 * entries; folds, projections, the changelog, recall, and coverage progress all
 * read through it, so they agree on what the branch remembers. An entry whose
 * marker is not on the branch (a worker that read a sibling branch, or an old
 * malformed record) changes nothing here.
 */
export function branchLedger(entries: Entry[]): BranchLedgerEntry[] {
	const indexes = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) indexes.set(entries[i].id, i);

	const ledger: BranchLedgerEntry[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!isLedgerEntry(entry)) continue;
		const coverageIndex = indexes.get(entry.data.coversUpToId);
		if (coverageIndex === undefined) continue;
		ledger.push({ entry, index, coverageIndex });
	}
	return ledger;
}

function isLedgerEntry(entry: Entry): entry is LedgerEntry {
	if (entry.type !== "custom" || !isRecord(entry.data) || !isNonEmptyString(entry.data.coversUpToId)) return false;
	const data = entry.data;
	switch (entry.customType) {
		case OM_OBSERVATIONS_RECORDED:
			return isNonEmptyArrayOf(data.observations, isObservation);
		case OM_REFLECTIONS_RECORDED:
			return isNonEmptyArrayOf(data.reflections, isReflection);
		case OM_OBSERVATIONS_DROPPED:
			return isNonEmptyStringArray(data.observationIds);
		default:
			return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function isNonEmptyArrayOf(value: unknown, guard: (item: unknown) => boolean): boolean {
	return Array.isArray(value) && value.length > 0 && value.every(guard);
}
