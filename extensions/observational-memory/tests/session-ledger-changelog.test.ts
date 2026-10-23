import { describe, expect, it } from "vitest";

import { changePreview, memoryChangelog } from "../src/session-ledger/index.ts";
import {
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.ts";

const obsA = observation("aaaaaaaaaaaa");
const obsB = observation("bbbbbbbbbbbb");
const refE = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

describe("memoryChangelog", () => {
	it("lists what each ledger entry added or dropped, oldest first", () => {
		const entries = [
			textCustomMessage("raw-1", "hello"),
			observationsRecordedEntry("om-1", { observations: [obsA, obsB], coversUpToId: "raw-1" }, { timestamp: "2026-10-23T09:02:11.000Z" }),
			reflectionsRecordedEntry("om-2", { reflections: [refE], coversUpToId: "om-1" }),
			observationsDroppedEntry("om-3", { observationIds: ["aaaaaaaaaaaa", "cccccccccccc"], coversUpToId: "om-1" }),
		];

		expect(memoryChangelog(entries)).toEqual([
			{ kind: "observed", entryId: "om-1", timestamp: "2026-10-23T09:02:11.000Z", observations: [obsA, obsB] },
			{ kind: "reflected", entryId: "om-2", timestamp: "2026-05-02T10:00:00.000Z", reflections: [refE] },
			{ kind: "dropped", entryId: "om-3", timestamp: "2026-05-02T10:00:00.000Z", observations: [obsA], unknownIds: ["cccccccccccc"] },
		]);
	});

	it("skips entries that only repeat known ids or cover an entry off the branch, like the projection", () => {
		const entries = [
			textCustomMessage("raw-1", "hello"),
			textCustomMessage("raw-2", "world"),
			observationsRecordedEntry("om-0", { observations: [obsB], coversUpToId: "raw-elsewhere" }),
			observationsRecordedEntry("om-1", { observations: [obsA], coversUpToId: "raw-1" }),
			observationsRecordedEntry("om-2", { observations: [{ ...obsA, content: "rewritten" }], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-3", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-1" }),
			observationsDroppedEntry("om-4", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-1" }),
		];

		expect(memoryChangelog(entries).map((change) => change.entryId)).toEqual(["om-1", "om-3"]);
	});
});

describe("changePreview", () => {
	it("names the stage, counts the records, and shortens the first few", () => {
		const long = observation("dddddddddddd", { content: `${"x".repeat(30)}\nsecond line` });
		const [change] = memoryChangelog([
			textCustomMessage("raw-1", "hello"),
			observationsRecordedEntry("om-1", { observations: [obsA, obsB, long, observation("ffffffffffff")], coversUpToId: "raw-1" }),
		]);

		expect(changePreview(change, 3, 20)).toBe(
			[
				"observer +4 observations",
				"  • Observation aaaaaaa…",
				"  • Observation bbbbbbb…",
				`  • ${"x".repeat(19)}…`,
				"  … 1 more",
			].join("\n"),
		);
	});
});
