import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return walk(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

/** `src/` files, relative to the extension root, with their text. */
export function extensionSources(): Array<{ path: string; text: string }> {
	return walk(join(root, "src")).map((path) => ({ path: relative(root, path), text: readFileSync(path, "utf8") }));
}
