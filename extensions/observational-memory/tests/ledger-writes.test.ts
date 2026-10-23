import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const JOURNAL = "src/memory-journal.ts";

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

// A worker's result is valid only on the branch it read; recordMemoryEntry
// checks that before appending. A direct appendEntry call skips the check.
it("appends ledger entries only through recordMemoryEntry", () => {
	const offenders = sourceFiles(join(root, "src"))
		.map((path) => relative(root, path))
		.filter((path) => path !== JOURNAL && /\bappendEntry\s*\(/.test(readFileSync(join(root, path), "utf8")));

	expect(offenders, `call recordMemoryEntry from ${JOURNAL} instead of pi.appendEntry`).toEqual([]);
});
