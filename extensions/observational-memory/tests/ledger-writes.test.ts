import { expect, it } from "vitest";

import { extensionSources } from "./fixtures/source-files.ts";

const JOURNAL = "src/memory-journal.ts";

// A worker's result is valid only on the branch it read; recordMemoryEntry
// checks that before appending. A direct appendEntry call skips the check.
it("appends ledger entries only through recordMemoryEntry", () => {
	const offenders = extensionSources()
		.filter(({ path, text }) => path !== JOURNAL && /\bappendEntry\s*\(/.test(text))
		.map(({ path }) => path);

	expect(offenders, `call recordMemoryEntry from ${JOURNAL} instead of pi.appendEntry`).toEqual([]);
});
