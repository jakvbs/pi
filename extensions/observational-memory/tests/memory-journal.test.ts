import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => mock.agentDir }));

import { syncMemoryFile } from "../src/memory-file.ts";
import { recordMemoryEntry } from "../src/memory-journal.ts";
import { OM_OBSERVATIONS_DROPPED, OM_OBSERVATIONS_RECORDED } from "../src/session-ledger/index.ts";
import { observation, observationsRecordedEntry, reflection, reflectionsRecordedEntry, textCustomMessage, type TestEntry } from "./fixtures/session.ts";

const obsA = observation("aaaaaaaaaaaa", { content: "User wants a changelog" });

function setup(initial: TestEntry[], config = { showWorkerNotifications: true, memoryFile: true }) {
	let entries = [...initial];
	const pi = {
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries = [...entries, { type: "custom", id: `appended-${entries.length}`, parentId: null, timestamp: "2026-10-23T09:10:00.000Z", customType, data }];
		}),
	};
	const notify = vi.fn();
	const ctx = {
		cwd: "/home/u/project",
		hasUI: true,
		ui: { notify },
		sessionManager: { getBranch: () => entries, getSessionId: () => "sess-1", getSessionFile: () => "/s/sess-1.jsonl" },
	};
	const record = (customType: typeof OM_OBSERVATIONS_RECORDED | typeof OM_OBSERVATIONS_DROPPED, data: unknown) =>
		recordMemoryEntry(pi, config, ctx, customType, data);
	return { record, notify, ctx, pi };
}

describe("recordMemoryEntry", () => {
	let agentDir: string;
	const memoryFile = () => join(agentDir, "observational-memory", "memory", "sess-1.md");

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "om-journal-"));
		mock.agentDir = agentDir;
	});

	afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

	it("appends the entry, notifies what it changed, and mirrors the memory to markdown", () => {
		const { record, notify, pi } = setup([
			textCustomMessage("raw-1", "hello"),
			reflectionsRecordedEntry("om-0", { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-1" }, { timestamp: "2026-10-23T09:00:00.000Z" }),
		]);

		record(OM_OBSERVATIONS_RECORDED, { observations: [obsA], coversUpToId: "raw-1" });

		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obsA], coversUpToId: "raw-1" });
		expect(notify.mock.calls).toEqual([["Observational memory: observer +1 observation\n  • User wants a changelog", "info"]]);
		expect(readFileSync(memoryFile(), "utf-8")).toBe(
			[
				"# Observational memory · sess-1",
				"",
				"- Project: `/home/u/project`",
				"- Session file: `/s/sess-1.jsonl`",
				"- Updated: 2026-10-23 09:10 UTC (observer +1 observation)",
				"- Memory: 1 reflections, 1 active observations",
				"",
				"## Reflections",
				"",
				"- [eeeeeeeeeeee] Reflection eeeeeeeeeeee",
				"",
				"## Observations",
				"",
				"- [aaaaaaaaaaaa] 2026-05-02T10:00:00.000Z [medium] User wants a changelog",
				"",
				"## Changelog",
				"",
				"### 2026-10-23 09:00 UTC · reflector +1 reflection",
				"",
				"- [eeeeeeeeeeee] Reflection eeeeeeeeeeee",
				"",
				"### 2026-10-23 09:10 UTC · observer +1 observation",
				"",
				"- [aaaaaaaaaaaa] 2026-05-02T10:00:00.000Z [medium] User wants a changelog",
				"",
			].join("\n"),
		);
	});

	it("stays quiet for an entry that changes nothing", () => {
		const { record, notify } = setup([observationsRecordedEntry("om-1", { observations: [obsA], coversUpToId: "raw-1" })], {
			showWorkerNotifications: true,
			memoryFile: false,
		});

		record(OM_OBSERVATIONS_RECORDED, { observations: [obsA], coversUpToId: "raw-2" });

		expect(notify).not.toHaveBeenCalled();
		expect(existsSync(memoryFile())).toBe(false);
	});

	it("honours showWorkerNotifications while still writing the file", () => {
		const { record, notify } = setup([], { showWorkerNotifications: false, memoryFile: true });

		record(OM_OBSERVATIONS_RECORDED, { observations: [obsA], coversUpToId: "raw-1" });

		expect(notify).not.toHaveBeenCalled();
		expect(readFileSync(memoryFile(), "utf-8")).toContain("observer +1 observation");
	});
});

describe("syncMemoryFile", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "om-file-"));
		mock.agentDir = agentDir;
	});

	afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

	it("writes nothing for a branch without memory", () => {
		const { ctx } = setup([textCustomMessage("raw-1", "hello")]);

		syncMemoryFile(true, ctx);

		expect(existsSync(join(agentDir, "observational-memory"))).toBe(false);
	});

	it("follows the branch it is given", () => {
		const { ctx } = setup([observationsRecordedEntry("om-1", { observations: [obsA], coversUpToId: "raw-1" })]);
		syncMemoryFile(true, ctx);
		const path = join(agentDir, "observational-memory", "memory", "sess-1.md");
		expect(readFileSync(path, "utf-8")).toContain("User wants a changelog");

		const other = setup([observationsRecordedEntry("om-9", { observations: [observation("bbbbbbbbbbbb")], coversUpToId: "raw-1" })]);
		syncMemoryFile(true, other.ctx);

		expect(readFileSync(path, "utf-8")).not.toContain("User wants a changelog");
	});
});
