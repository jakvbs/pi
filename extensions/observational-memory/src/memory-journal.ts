import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { debugLog } from "./debug-log.ts";
import { syncMemoryFile, type MemoryFileCtx } from "./memory-file.ts";
import { changePreview, memoryChangelog, type Entry, type V3MemoryCustomType } from "./session-ledger/index.ts";

export type MemoryJournalCtx = MemoryFileCtx & {
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
};

/**
 * The only way memory workers write the ledger: append the entry, then tell the
 * user what it changed and refresh the memory file.
 *
 * `readBranch` is the branch the worker read its input from. A worker runs
 * across awaits, and meanwhile the user can move to another branch; the entry
 * would then land on a branch whose source the worker never read. It is
 * appended only while the tip of `readBranch` is still on the current branch,
 * so everything the worker read is an ancestor of the new entry. Returns
 * whether the entry was appended.
 */
export function recordMemoryEntry(
	pi: Pick<ExtensionAPI, "appendEntry">,
	config: Pick<Config, "showWorkerNotifications" | "memoryFile">,
	ctx: MemoryJournalCtx,
	readBranch: readonly Entry[],
	customType: V3MemoryCustomType,
	data: unknown,
): boolean {
	const readTipId = readBranch.at(-1)?.id;
	const current = ctx.sessionManager.getBranch() as Entry[];
	if (!readTipId || !current.some((entry) => entry.id === readTipId)) {
		debugLog("memory_journal.branch_moved", { customType, readTipId, currentTipId: current.at(-1)?.id });
		return false;
	}

	pi.appendEntry(customType, data);
	const branch = ctx.sessionManager.getBranch() as Entry[];
	const change = memoryChangelog(branch).at(-1);
	if (change && change.entryId === branch.at(-1)?.id && config.showWorkerNotifications && ctx.hasUI) {
		ctx.ui?.notify(`Observational memory: ${changePreview(change)}`, "info");
	}
	syncMemoryFile(config.memoryFile, ctx);
	return true;
}
