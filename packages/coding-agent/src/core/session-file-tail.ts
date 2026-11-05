// Reads a session file that another pi process may still be writing, without ever writing to it.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileEntry, SessionEntry } from "./session-manager.ts";

/** What one `SessionFileTail.read()` found since the previous read. */
export type SessionTailRead =
	| { type: "none" }
	/** New whole entries; `continuesLeaf` is false when the first one does not hang off the last entry read before. */
	| { type: "append"; entries: SessionEntry[]; continuesLeaf: boolean }
	/** The file shrank, so it was rewritten: every entry it holds now. */
	| { type: "reload"; entries: FileEntry[] };

/**
 * Follows a session file by byte offset. Only whole lines count: pi appends one line per entry, so a line
 * without its newline is a write in progress and waits for the next read. Malformed lines are skipped.
 */
export class SessionFileTail {
	readonly path: string;
	private offset = 0;
	private pending = Buffer.alloc(0);
	private lastEntryId: string | null = null;

	constructor(path: string) {
		this.path = path;
	}

	/** Read every whole entry in the file from the start. */
	readAll(): FileEntry[] {
		this.offset = 0;
		this.pending = Buffer.alloc(0);
		this.lastEntryId = null;
		return this.readLines();
	}

	/** Read the whole entries appended since the previous read. */
	read(): SessionTailRead {
		const size = statSync(this.path).size;
		if (size < this.offset) return { type: "reload", entries: this.readAll() };
		if (size === this.offset) return { type: "none" };
		const previousLeaf = this.lastEntryId;
		const entries = this.readLines().filter((entry): entry is SessionEntry => entry.type !== "session");
		if (entries.length === 0) return { type: "none" };
		return { type: "append", entries, continuesLeaf: entries[0].parentId === previousLeaf };
	}

	private readLines(): FileEntry[] {
		const fd = openSync(this.path, "r");
		const chunks = [this.pending];
		try {
			const size = fstatSync(fd).size;
			while (this.offset < size) {
				const buffer = Buffer.allocUnsafe(Math.min(size - this.offset, READ_CHUNK_BYTES));
				const bytesRead = readSync(fd, buffer, 0, buffer.length, this.offset);
				if (bytesRead === 0) break;
				chunks.push(buffer.subarray(0, bytesRead));
				this.offset += bytesRead;
			}
		} finally {
			closeSync(fd);
		}
		const data = Buffer.concat(chunks);
		const end = data.lastIndexOf(NEWLINE);
		this.pending = Buffer.from(data.subarray(end + 1));
		const entries: FileEntry[] = [];
		for (const line of data
			.subarray(0, end + 1)
			.toString("utf8")
			.split("\n")) {
			const entry = parseLine(line);
			if (!entry) continue;
			entries.push(entry);
			if (entry.type !== "session") this.lastEntryId = entry.id;
		}
		return entries;
	}
}

const READ_CHUNK_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

function parseLine(line: string): FileEntry | undefined {
	if (!line.trim()) return undefined;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		return undefined;
	}
}

/**
 * The session file a view of `target` shows: the file itself, or the newest `.jsonl` when `target` is a
 * directory. Undefined while there is no such file yet.
 */
export function resolveSessionViewFile(target: string): string | undefined {
	if (!existsSync(target)) return undefined;
	if (!statSync(target).isDirectory()) return target;
	let newest: { path: string; mtimeMs: number } | undefined;
	for (const name of readdirSync(target)) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(target, name);
		const { mtimeMs } = statSync(path);
		if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
	}
	return newest?.path;
}

/** Poll interval of the view: entries appear within about a quarter second of the writer's append. */
export const SESSION_VIEW_POLL_MS = 250;

/**
 * Wait until `target` names a session file whose header has been written, then return its tail and the
 * entries read so far. Calls `onWait` once if it has to wait.
 */
export async function openSessionFileTail(
	target: string,
	onWait: () => void,
): Promise<{ tail: SessionFileTail; entries: FileEntry[] }> {
	let waited = false;
	while (true) {
		const path = resolveSessionViewFile(target);
		if (path) {
			const tail = new SessionFileTail(path);
			const entries = tail.readAll();
			if (entries[0]?.type === "session") return { tail, entries };
			if (entries.length > 0) throw new Error(`Not a session file: ${path}`);
		}
		if (!waited) onWait();
		waited = true;
		await new Promise((resolve) => setTimeout(resolve, SESSION_VIEW_POLL_MS));
	}
}
