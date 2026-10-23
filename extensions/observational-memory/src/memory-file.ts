import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debugLog, safeDebugLogSessionId } from "./debug-log.ts";
import type { Runtime } from "./runtime.ts";
import {
	changeHeadline,
	changeTimestamp,
	fullProjection,
	memoryChangelog,
	observationToSummaryLine,
	reflectionToSummaryLine,
	type Entry,
} from "./session-ledger/index.ts";

export const MEMORY_FILE_DIR_RELATIVE_PATH = join("observational-memory", "memory");

export type MemoryFileCtx = {
	cwd: string;
	sessionManager: {
		getBranch: () => unknown;
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

export function memoryFilePath(sessionId: string | undefined): string | undefined {
	const safeSessionId = safeDebugLogSessionId(sessionId);
	return safeSessionId ? join(getAgentDir(), MEMORY_FILE_DIR_RELATIVE_PATH, `${safeSessionId}.md`) : undefined;
}

function bulletList(lines: string[], empty: string): string {
	return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : `_${empty}_`;
}

/**
 * Markdown view of the current branch memory; `/om:log` and the ledger hold
 * the history. Rendered only from the ledger, so rewriting it without a new
 * change yields the same bytes. Undefined while the branch has no memory.
 */
export function renderMemoryFile(args: { sessionId: string; cwd: string; sessionFile?: string; entries: Entry[] }): string | undefined {
	const latest = memoryChangelog(args.entries).at(-1);
	if (!latest) return undefined;
	const memory = fullProjection(args.entries);

	return [
		`# Observational memory · ${args.sessionId}`,
		"",
		`- Project: \`${args.cwd}\``,
		...(args.sessionFile ? [`- Session file: \`${args.sessionFile}\``] : []),
		`- Updated: ${changeTimestamp(latest)} (${changeHeadline(latest)})`,
		`- Memory: ${memory.reflections.length} reflections, ${memory.observations.length} active observations`,
		"",
		"## Reflections",
		"",
		bulletList(memory.reflections.map(reflectionToSummaryLine), "No reflections."),
		"",
		"## Observations",
		"",
		bulletList(memory.observations.map(observationToSummaryLine), "No active observations."),
		"",
	].join("\n");
}

function readOrUndefined(path: string): string | undefined {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

/** Rewrite the session's memory file from the current branch when `memoryFile` is on. Never throws. */
export function syncMemoryFile(enabled: boolean, ctx: MemoryFileCtx): void {
	if (!enabled) return;
	try {
		const sessionId = ctx.sessionManager.getSessionId?.();
		const path = memoryFilePath(sessionId);
		if (!sessionId || !path) return;
		const content = renderMemoryFile({
			sessionId,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile?.(),
			entries: ctx.sessionManager.getBranch() as Entry[],
		});
		if (content === undefined || readOrUndefined(path) === content) return;
		mkdirSync(dirname(path), { recursive: true });
		// Rename over the old file so an editor or `watch` never reads a half-written one.
		const tmpPath = `${path}.tmp`;
		writeFileSync(tmpPath, content, "utf-8");
		renameSync(tmpPath, path);
	} catch (error) {
		debugLog("memory_file.error", { message: error instanceof Error ? error.message : String(error) });
	}
}

/** Bring the memory file in line with the branch Pi resumed or navigated to. */
export function registerMemoryFile(pi: Pick<ExtensionAPI, "on">, runtime: Runtime): void {
	const sync = (_event: unknown, ctx: ExtensionContext) => {
		runtime.ensureConfig(ctx.cwd);
		syncMemoryFile(runtime.config.memoryFile, ctx);
	};
	pi.on("session_start", sync);
	pi.on("session_tree", sync);
}
