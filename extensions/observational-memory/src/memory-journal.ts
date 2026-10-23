import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { syncMemoryFile, type MemoryFileCtx } from "./memory-file.ts";
import { changePreview, memoryChangelog, type Entry, type V3MemoryCustomType } from "./session-ledger/index.ts";

export type MemoryJournalCtx = MemoryFileCtx & {
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
};

/**
 * The only way memory workers write the ledger: append the entry, then tell the
 * user what it changed and refresh the memory file.
 */
export function recordMemoryEntry(
	pi: Pick<ExtensionAPI, "appendEntry">,
	config: Pick<Config, "showWorkerNotifications" | "memoryFile">,
	ctx: MemoryJournalCtx,
	customType: V3MemoryCustomType,
	data: unknown,
): void {
	pi.appendEntry(customType, data);
	const branch = ctx.sessionManager.getBranch() as Entry[];
	const change = memoryChangelog(branch).at(-1);
	if (change && change.entryId === branch.at(-1)?.id && config.showWorkerNotifications && ctx.hasUI) {
		ctx.ui?.notify(`Observational memory: ${changePreview(change)}`, "info");
	}
	syncMemoryFile(config.memoryFile, ctx);
}
