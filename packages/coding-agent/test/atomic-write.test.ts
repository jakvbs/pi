import { chmod, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

// F049: a `sed -i` run by bash in parallel with an edit of the same file streamed the file while the edit
// truncated and rewrote it in place; sed hit an early EOF and renamed its partial copy over the file.
describe("edit and write replace files atomically", () => {
	let dir: string;
	let file: string;
	const original = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-atomic-write-"));
		file = join(dir, "file.txt");
		await writeFile(file, original);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	// Reads half the file, runs `mutate`, then reads the rest through the same open handle.
	async function readAcross(mutate: () => Promise<unknown>): Promise<string> {
		const handle = await open(file, "r");
		try {
			const buffer = Buffer.alloc(original.length * 2);
			const half = Math.floor(original.length / 2);
			await handle.read(buffer, 0, half, 0);
			await mutate();
			const { bytesRead } = await handle.read(buffer, half, buffer.length - half, half);
			return buffer.toString("utf-8", 0, half + bytesRead);
		} finally {
			await handle.close();
		}
	}

	it("edit: a reader that opened the file before the edit reads the old content in full", async () => {
		const edit = createEditTool(dir);
		const seen = await readAcross(() =>
			edit.execute("edit", { path: "file.txt", edits: [{ oldText: "line 1\nline 2\n", newText: "" }] }),
		);
		expect(seen).toBe(original);
		expect(await readFile(file, "utf-8")).toBe(original.replace("line 1\nline 2\n", ""));
	});

	it("write: a reader that opened the file before the write reads the old content in full", async () => {
		const write = createWriteTool(dir);
		const seen = await readAcross(() => write.execute("write", { path: "file.txt", content: "short" }));
		expect(seen).toBe(original);
		expect(await readFile(file, "utf-8")).toBe("short");
	});

	it("keeps the file mode and replaces the symlink target, not the symlink", async () => {
		await chmod(file, 0o755);
		const link = join(dir, "link.txt");
		await symlink(file, link);
		await createWriteTool(dir).execute("write", { path: "link.txt", content: "via link" });
		expect(await readFile(file, "utf-8")).toBe("via link");
		expect((await stat(file)).mode & 0o777).toBe(0o755);
		expect(await readFile(link, "utf-8")).toBe("via link");
	});

	// A rename over the target ignores the target's own mode, so the write must check write access itself.
	it("write: refuses a read-only file and keeps its content", async () => {
		await chmod(file, 0o444);
		await expect(createWriteTool(dir).execute("write", { path: "file.txt", content: "new" })).rejects.toThrow(
			/EACCES/,
		);
		expect(await readFile(file, "utf-8")).toBe(original);
	});
});
