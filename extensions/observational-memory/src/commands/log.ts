import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { memoryFilePath } from "../memory-file.ts";
import type { Runtime } from "../runtime.ts";
import { changeHeadline, changeItems, changeTimestamp, memoryChangelog, type Entry, type MemoryChange } from "../session-ledger/index.ts";

const DEFAULT_LIMIT = 20;

type LogOptions = { full: boolean; limit: number };

function parseArgs(args: unknown): LogOptions | undefined {
	const words = typeof args === "string" ? args.trim().split(/\s+/).filter(Boolean) : [];
	const options: LogOptions = { full: false, limit: DEFAULT_LIMIT };
	for (const word of words) {
		if (word === "full") options.full = true;
		else if (/^[1-9]\d*$/.test(word)) options.limit = Number(word);
		else return undefined;
	}
	return options;
}

function renderChange(change: MemoryChange, full: boolean): string {
	const headline = `${changeTimestamp(change)} · ${changeHeadline(change)}`;
	return full ? [headline, ...changeItems(change).map((line) => `  - ${line}`)].join("\n") : headline;
}

export function renderMemoryLog(entries: Entry[], options: LogOptions): string {
	const changes = memoryChangelog(entries);
	if (changes.length === 0) return "No memory changes on this branch yet.";
	const shown = changes.slice(-options.limit);
	const title = shown.length < changes.length
		? `Memory changelog (last ${shown.length} of ${changes.length}, oldest first):`
		: `Memory changelog (${changes.length}, oldest first):`;
	return [title, ...shown.map((change) => renderChange(change, options.full))].join(options.full ? "\n\n" : "\n");
}

export function registerLogCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:log", {
		description: "Show what the memory workers added and dropped on this branch (full for contents, N for the last N changes)",
		handler: async (args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const options = parseArgs(args);
			if (!options) {
				ctx.ui.notify("Usage: /om:log [full] [N]", "info");
				return;
			}
			const lines = [renderMemoryLog(ctx.sessionManager.getBranch() as Entry[], options)];
			const path = runtime.config.memoryFile ? memoryFilePath(ctx.sessionManager.getSessionId()) : undefined;
			if (path) lines.push("", `Memory file: ${path}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
