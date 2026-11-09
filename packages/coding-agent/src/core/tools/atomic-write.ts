// Atomic file replacement for the edit and write tools: a complete temporary copy is renamed over the target.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Replace the file at `path` with `content`. A concurrent reader (for example a `sed -i` started by bash)
 * sees the old or the new file in full, never a truncated one. Follows symlinks, keeps the file mode and,
 * like an in-place write, refuses an existing file without write permission (`EACCES`).
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
	const target = await resolveTarget(path);
	const mode = await existingMode(target);
	// rename() replaces the directory entry and ignores the target's own mode bits.
	if (mode !== undefined) await access(target, constants.W_OK);
	const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		await writeFile(temp, content, { encoding: "utf-8", flag: "wx" });
		if (mode !== undefined) await chmod(temp, mode);
		await rename(temp, target);
	} catch (error) {
		await unlink(temp).catch(() => {});
		throw error;
	}
}

async function resolveTarget(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if (isMissing(error)) return path;
		throw error;
	}
}

async function existingMode(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mode & 0o7777;
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
