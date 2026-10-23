import { describe, expect, it } from "vitest";

import {
	OM_OBSERVATIONS_RECORDED,
	branchLedger,
	foldLedger,
	fullProjection,
	latestCoverageIndex,
	memoryChangelog,
	recallMemorySources,
} from "../src/session-ledger/index.ts";
import {
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.ts";

describe("branch ledger", () => {
	it("keeps valid V3 entries whose coverage marker is on the branch, in branch order", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-ref" }),
		];

		expect(branchLedger(entries).map(({ entry, index, coverageIndex }) => [entry.id, index, coverageIndex])).toEqual([
			["om-obs", 1, 0],
			["om-ref", 2, 0],
			["om-drop", 3, 2],
		]);
	});

	it("rejects empty, malformed, and old V2 entries", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("empty-obs", { observations: [], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("empty-ref", { reflections: [], coversUpToId: "raw-1" }),
			observationsDroppedEntry("empty-drop", { observationIds: [], coversUpToId: "raw-1" }),
			observationsRecordedEntry("bad-obs", { observations: [{ ...observation("aaaaaaaaaaaa"), sourceEntryIds: [] }], coversUpToId: "raw-1" }),
			oldV2ObservationEntry("v2-obs", { coversUpToId: "raw-1" }),
		];

		expect(branchLedger(entries)).toEqual([]);
		expect(latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED)).toBe(-1);
	});

	// Real shape from a 2026-10-18 session: the observer read a branch ending at
	// `6fe29b75`, the user went back to its parent `54e12a5b`, and the entry
	// `8cf08929` landed on the new branch with a marker that is not on it.
	it("ignores an entry whose coverage marker is on a sibling branch, in every reader", () => {
		const stray = observation("bbbbbbbbbbbb", { sourceEntryIds: ["54e12a5b", "6fe29b75"] });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
			textCustomMessage("54e12a5b", "bbbb"),
			observationsRecordedEntry("8cf08929", { observations: [stray], coversUpToId: "6fe29b75" }),
		];

		expect(branchLedger(entries).map(({ entry }) => entry.id)).toEqual(["om-obs"]);
		expect(foldLedger(entries).observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(fullProjection(entries).observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(memoryChangelog(entries).map((change) => change.entryId)).toEqual(["om-obs"]);
		expect(recallMemorySources(entries, "bbbbbbbbbbbb").status).toBe("not_found");
		expect(latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED)).toBe(0);
	});
});
