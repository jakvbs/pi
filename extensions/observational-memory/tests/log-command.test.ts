import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "/agent" }));

import { registerLogCommand } from "../src/commands/log.ts";
import {
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	type TestEntry,
} from "./fixtures/session.ts";

const entries: TestEntry[] = [
	observationsRecordedEntry("om-1", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }, { timestamp: "2026-10-23T09:02:11.000Z" }),
	reflectionsRecordedEntry("om-2", { reflections: [reflection("eeeeeeeeeeee")], coversUpToId: "om-1" }, { timestamp: "2026-10-23T09:05:00.000Z" }),
	observationsDroppedEntry("om-3", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-1" }, { timestamp: "2026-10-23T09:06:00.000Z" }),
];

function setup(branch: TestEntry[], memoryFile = false) {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const pi = { registerCommand: vi.fn((_name: string, command: { handler: typeof handler }) => (handler = command.handler)) };
	registerLogCommand(pi as any, { ensureConfig: vi.fn(), config: { memoryFile } } as any);
	const notify = vi.fn();
	const ctx = { cwd: "/p", ui: { notify }, sessionManager: { getBranch: () => branch, getSessionId: () => "sess-1" } };
	return async (args = "") => {
		await handler!(args, ctx);
		return notify.mock.calls.at(-1)?.[0] as string;
	};
}

describe("/om:log", () => {
	it("lists one line per memory change, oldest first", async () => {
		expect(await setup(entries)()).toBe(
			[
				"Memory changelog (3, oldest first):",
				"2026-10-23 09:02 UTC · observer +1 observation",
				"2026-10-23 09:05 UTC · reflector +1 reflection",
				"2026-10-23 09:06 UTC · dropper −1 observation",
			].join("\n"),
		);
	});

	it("shows the records with full and keeps only the last N changes", async () => {
		expect(await setup(entries)("full 2")).toBe(
			[
				"Memory changelog (last 2 of 3, oldest first):",
				"2026-10-23 09:05 UTC · reflector +1 reflection\n  - [eeeeeeeeeeee] Reflection eeeeeeeeeeee",
				"2026-10-23 09:06 UTC · dropper −1 observation\n  - [aaaaaaaaaaaa] 2026-05-02T10:00:00.000Z [medium] Observation aaaaaaaaaaaa",
			].join("\n\n"),
		);
	});

	it("points at the memory file when it is enabled", async () => {
		expect(await setup([], true)()).toBe("No memory changes on this branch yet.\n\nMemory file: /agent/observational-memory/memory/sess-1.md");
	});

	it("rejects unknown arguments", async () => {
		expect(await setup(entries)("everything")).toBe("Usage: /om:log [full] [N]");
	});
});
