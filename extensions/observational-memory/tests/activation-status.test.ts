import { describe, expect, it, vi } from "vitest";

import { ACTIVATION_STATUS_KEY, registerActivationStatus } from "../src/activation-status.ts";
import { DEFAULTS } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function setup(options: { compactAfterTokens?: number; contextWindow?: number; passive?: boolean } = {}) {
	const handlers = new Map<string, Handler>();
	const pi = { on: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)) };
	const runtime = new Runtime();
	runtime.config = {
		...DEFAULTS,
		compactAfterTokens: options.compactAfterTokens ?? 400_000,
		passive: options.passive ?? false,
	};
	runtime.configLoaded = true;
	let tokens: number | null = null;
	const contextWindow = options.contextWindow ?? 1_000_000;
	const statuses = new Map<string, string | undefined>();
	const ctx = {
		hasUI: true,
		cwd: "/tmp/project",
		model: { contextWindow },
		getContextUsage: () => ({ tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 }),
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
		},
	};
	registerActivationStatus(pi as never, runtime);
	return {
		status: () => statuses.get(ACTIVATION_STATUS_KEY),
		setContextTokens: (value: number | null) => {
			tokens = value;
		},
		fire: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
	};
}

describe("activation status", () => {
	it("shows the context Pi reports as a share of the activation threshold", () => {
		const om = setup();
		om.setContextTokens(197_232);

		om.fire("session_start");
		expect(om.status()).toBe("compact 49%");

		om.setContextTokens(412_000);
		om.fire("turn_end", { entries: [] });
		expect(om.status()).toBe("compact 103%");
	});

	it("shows an unknown share while Pi does not know the context size after a compaction", () => {
		const om = setup();
		om.setContextTokens(401_000);

		om.fire("turn_end", { entries: [{ type: "compaction" }] });
		expect(om.status()).toBe("compact ?");

		om.setContextTokens(null);
		om.fire("session_compact");
		expect(om.status()).toBe("compact ?");
	});

	it("hides the status when memory does not activate first", () => {
		const passive = setup({ passive: true });
		passive.setContextTokens(100_000);
		passive.fire("session_start");
		expect(passive.status()).toBeUndefined();

		const smallWindow = setup({ contextWindow: 272_000 });
		smallWindow.setContextTokens(100_000);
		smallWindow.fire("session_start");
		expect(smallWindow.status()).toBeUndefined();
	});
});
