import { describe, expect, it, vi } from "vitest";

import { registerStatusCommand } from "../src/commands/status.ts";
import { DEFAULTS } from "../src/config.ts";
import { MEMORY_STATUS_EVENT, type MemoryStatus, registerMemoryStatusEvents, renderMemoryStatus } from "../src/memory-status.ts";
import { Runtime } from "../src/runtime.ts";
import { observation, observationsRecordedEntry, textCustomMessage } from "./fixtures/session.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function setup() {
	const handlers = new Map<string, Handler>();
	let statusCommand: ((args: unknown, ctx: unknown) => Promise<void>) | undefined;
	const published: MemoryStatus[] = [];
	const pi = {
		on: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
		registerCommand: vi.fn((_name: string, command: { handler: typeof statusCommand }) => {
			statusCommand = command.handler;
		}),
		events: {
			emit: vi.fn((channel: string, data: unknown) => {
				if (channel === MEMORY_STATUS_EVENT) published.push(data as MemoryStatus);
			}),
		},
	};
	const runtime = new Runtime();
	runtime.config = { ...DEFAULTS, observeAfterTokens: 10, compactAfterTokens: 400_000 };
	runtime.configLoaded = true;
	const entries = [
		textCustomMessage("raw-1", "aaaaaaaa"),
		observationsRecordedEntry("om-obs", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
		textCustomMessage("raw-2", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
	];
	const notify = vi.fn();
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify },
		sessionManager: { getBranch: () => entries },
		model: { contextWindow: 1_000_000 },
		getContextUsage: () => ({ tokens: 12_000, contextWindow: 1_000_000, percent: 1.2 }),
	};
	registerMemoryStatusEvents(pi as never, runtime);
	registerStatusCommand(pi as never, runtime);
	return {
		runtime,
		published,
		fire: (name: string) => handlers.get(name)?.({ entries: [] }, ctx),
		statusText: async () => {
			await statusCommand!(undefined, ctx);
			return notify.mock.calls.at(-1)?.[0] as string;
		},
	};
}

describe("memory status events", () => {
	it("publishes at turn_end the status /om:status prints", async () => {
		const om = setup();

		om.fire("turn_end");

		expect(om.published).toHaveLength(1);
		const [status] = om.published;
		expect(status.memory).toEqual(["Observations: 1 recorded / 0 dropped / 1 active / 0 visible +1", "Reflections:  0 recorded / 0 visible"]);
		expect(status.activity[0]).toBe("Next observation: ~19 / 10 tokens (190%)");
		expect(status.activity[2]).toBe("Next activation:  ~12,000 / 400,000 context tokens (3%)");
		expect(renderMemoryStatus(status)).toBe(await om.statusText());
	});

	it("publishes the stage error once the consolidation pass launched at that event ends", async () => {
		const om = setup();
		let finish!: () => void;
		om.runtime.consolidationInFlight = true;
		om.runtime.consolidationPhase = "observer";
		om.runtime.consolidationPromise = new Promise<void>((resolve) => {
			finish = resolve;
		});

		om.fire("turn_end");
		om.fire("turn_end");
		expect(om.published.map((status) => status.inFlight)).toEqual([["Consolidation: running (observer)"], ["Consolidation: running (observer)"]]);

		om.runtime.consolidationInFlight = false;
		om.runtime.consolidationPhase = undefined;
		om.runtime.lastObserverError = "observer failed: 400 Bad Request";
		finish();
		await vi.waitFor(() => expect(om.published).toHaveLength(3));

		const last = om.published[2];
		expect(last.inFlight).toEqual([]);
		expect(last.errors).toEqual({ observer: "observer failed: 400 Bad Request" });
		expect(await om.statusText()).toContain("Observer: observer failed: 400 Bad Request");
		expect(renderMemoryStatus(last)).toBe(await om.statusText());
	});
});
