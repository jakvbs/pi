// Reads a session file that another pi process may still be writing, without ever writing to it.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileEntry, SessionEntry } from "./session-manager.ts";

/** What one `SessionFileTail.read()` found since the previous read. */
export type SessionTailRead =
	| { type: "none" }
	/** New whole entries; `continuesLeaf` is false when the first one does not hang off the last entry read before. */
	| { type: "append"; entries: SessionEntry[]; continuesLeaf: boolean }
	/** The file was replaced or rewritten: every entry it holds now, its own session header first. */
	| { type: "reload"; entries: FileEntry[] };

/**
 * Follows a session file by byte offset. Only whole lines count: pi appends one line per entry, so a line
 * without its newline is a write in progress and waits for the next read. Malformed lines are skipped.
 * A file with another inode, a shorter size or another header line than the one read before was replaced
 * or rewritten, and is read again from the start.
 */
export class SessionFileTail {
	readonly path: string;
	private offset = 0;
	private pending = Buffer.alloc(0);
	private lastEntryId: string | null = null;
	/** Inode and header line of the file read so far; undefined until a whole session header was read. */
	private identity: { ino: number; header: Buffer } | undefined;

	constructor(path: string) {
		this.path = path;
	}

	/** Read every whole entry in the file from the start. */
	readAll(): FileEntry[] {
		const fd = openSync(this.path, "r");
		try {
			return this.readFromStart(fd);
		} finally {
			closeSync(fd);
		}
	}

	/** Read the whole entries appended since the previous read, or all of them when the file was rewritten. */
	read(): SessionTailRead {
		const fd = openSync(this.path, "r");
		try {
			if (!this.isSameFile(fd)) {
				const entries = this.readFromStart(fd);
				// An emptied file, or one whose header is still being written, keeps the view as it is until
				// the header is whole: a reload without it would invent a session id.
				return this.identity ? { type: "reload", entries } : { type: "none" };
			}
			if (fstatSync(fd).size === this.offset) return { type: "none" };
			const previousLeaf = this.lastEntryId;
			const entries = this.readLines(fd).filter((entry): entry is SessionEntry => entry.type !== "session");
			if (entries.length === 0) return { type: "none" };
			return { type: "append", entries, continuesLeaf: entries[0].parentId === previousLeaf };
		} finally {
			closeSync(fd);
		}
	}

	private isSameFile(fd: number): boolean {
		if (!this.identity) return false;
		const { ino, size } = fstatSync(fd);
		const { header } = this.identity;
		if (ino !== this.identity.ino || size < this.offset) return false;
		const bytes = Buffer.alloc(header.length);
		return readSync(fd, bytes, 0, bytes.length, 0) === bytes.length && bytes.equals(header);
	}

	private readFromStart(fd: number): FileEntry[] {
		this.offset = 0;
		this.pending = Buffer.alloc(0);
		this.lastEntryId = null;
		this.identity = undefined;
		const entries = this.readLines(fd);
		if (entries[0]?.type !== "session") {
			// Without a header the next read starts over, so the header is never dropped as an append.
			this.offset = 0;
			this.pending = Buffer.alloc(0);
			return entries;
		}
		this.identity = { ino: fstatSync(fd).ino, header: readFirstLine(fd) };
		return entries;
	}

	private readLines(fd: number): FileEntry[] {
		const chunks = [this.pending];
		const size = fstatSync(fd).size;
		while (this.offset < size) {
			const buffer = Buffer.allocUnsafe(Math.min(size - this.offset, READ_CHUNK_BYTES));
			const bytesRead = readSync(fd, buffer, 0, buffer.length, this.offset);
			if (bytesRead === 0) break;
			chunks.push(buffer.subarray(0, bytesRead));
			this.offset += bytesRead;
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

const HEADER_CHUNK_BYTES = 4096;

/** The first line of the file with its newline; the caller has read a whole line from it already. */
function readFirstLine(fd: number): Buffer {
	const chunks: Buffer[] = [];
	let position = 0;
	while (true) {
		const buffer = Buffer.allocUnsafe(HEADER_CHUNK_BYTES);
		const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
		const end = buffer.subarray(0, bytesRead).indexOf(NEWLINE);
		if (end >= 0) {
			chunks.push(buffer.subarray(0, end + 1));
			return Buffer.concat(chunks);
		}
		if (bytesRead === 0) return Buffer.concat(chunks);
		chunks.push(buffer.subarray(0, bytesRead));
		position += bytesRead;
	}
}

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
