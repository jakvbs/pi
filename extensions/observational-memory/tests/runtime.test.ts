import { describe, expect, it, vi } from "vitest";

import { Runtime } from "../src/runtime.ts";

/** A registry that knows the given models by provider and id. */
function modelRegistry(...models: Array<{ provider: string; id: string }>) {
	return {
		find: vi.fn((provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id)),
	};
}

describe("Runtime V3 behavior", () => {
	it("uses configured model when present", () => {
		const runtime = new Runtime();
		const configured = { provider: "anthropic", id: "configured" };
		const registry = modelRegistry(configured);
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "configured" } };

		const result = runtime.resolveModel({ model: { provider: "openai" }, modelRegistry: registry, hasUI: false });

		expect(registry.find).toHaveBeenCalledWith("anthropic", "configured");
		expect(result).toEqual({ ok: true, model: configured });
	});

	it("falls back to session model and notifies when configured model is missing", () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const sessionModel = { provider: "openai" };
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "missing" } };

		const result = runtime.resolveModel({ model: sessionModel, modelRegistry: modelRegistry(), hasUI: true, ui: { notify } });

		expect(result).toEqual({ ok: true, model: sessionModel });
		expect(notify).toHaveBeenCalledWith(
			"Observational memory: configured model anthropic/missing not found, using session model",
			"warning",
		);
	});

	it("returns the session model without consulting credentials", () => {
		const runtime = new Runtime();
		const sessionModel = Object.freeze({ provider: "openai-codex", id: "gpt-5-codex", baseUrl: "https://chatgpt.com/backend-api" });

		const result = runtime.resolveModel({ model: sessionModel, modelRegistry: modelRegistry(), hasUI: false });

		expect(result).toEqual({ ok: true, model: sessionModel });
		if (!result.ok) throw new Error("model resolution failed");
		expect(result.model).toBe(sessionModel);
	});

	it("reports that no model is available", () => {
		const runtime = new Runtime();
		expect(runtime.resolveModel({ model: undefined, modelRegistry: modelRegistry(), hasUI: false })).toEqual({
			ok: false,
			reason: "no model available (session has no model and no observational-memory model configured)",
		});
	});

	it("tracks consolidation task state", async () => {
		const runtime = new Runtime();
		let release: (() => void) | undefined;
		const work = new Promise<void>((resolve) => {
			release = resolve;
		});

		const promise = runtime.launchConsolidationTask({ hasUI: false }, async () => {
			runtime.consolidationPhase = "observer";
			await work;
		});

		expect(runtime.consolidationInFlight).toBe(true);
		expect(runtime.consolidationPromise).toBe(promise);
		expect(runtime.consolidationPhase).toBe("observer");
		release?.();
		await promise;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPromise).toBeNull();
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("records stage-specific consolidation errors", () => {
		const runtime = new Runtime();
		const notify = vi.fn();

		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "observer", new Error("observe failed"))).toBe("observe failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "reflector", new Error("reflect failed"))).toBe("reflect failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "dropper", "drop failed")).toBe("drop failed");

		expect(runtime.lastObserverError).toBe("observe failed");
		expect(runtime.lastReflectorError).toBe("reflect failed");
		expect(runtime.lastDropperError).toBe("drop failed");
		expect(notify).toHaveBeenCalledWith("Observational memory: observer failed: observe failed", "warning");
		expect(notify).toHaveBeenCalledWith("Observational memory: reflector failed: reflect failed", "warning");
		expect(notify).toHaveBeenCalledWith("Observational memory: dropper failed: drop failed", "warning");
	});

	it("keeps the compaction hook flag independent of consolidation", () => {
		const runtime = new Runtime();
		runtime.compactHookInFlight = true;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	describe("fallback model", () => {
		const FALLBACK = { provider: "opencode-go", id: "deepseek-v4.1-flash" };

		it("uses the fallback when no primary model is available", () => {
			const runtime = new Runtime();
			const notify = vi.fn();
			runtime.config = { ...runtime.config, fallbackModel: { ...FALLBACK } };

			const result = runtime.resolveModel({ model: undefined, modelRegistry: modelRegistry(FALLBACK), hasUI: true, ui: { notify } });

			expect(result).toEqual({
				ok: true,
				model: FALLBACK,
				fallbackUsed: true,
				primaryFailure: "no model available (session has no model and no observational-memory model configured)",
			});
			expect(notify).toHaveBeenCalledWith(
				"Observational memory: primary model unavailable (no model available (session has no model and no observational-memory model configured)); using fallback opencode-go/deepseek-v4.1-flash",
				"warning",
			);
		});

		it("does not consult the fallback when a primary model is available", () => {
			const runtime = new Runtime();
			const primary = { provider: "anthropic", id: "haiku" };
			runtime.config = { ...runtime.config, fallbackModel: { ...FALLBACK } };
			const registry = modelRegistry(FALLBACK);

			expect(runtime.resolveModel({ model: primary, modelRegistry: registry, hasUI: false })).toEqual({ ok: true, model: primary });
			expect(registry.find).not.toHaveBeenCalled();
		});

		it("reports both reasons when neither the primary nor the fallback is available", () => {
			const runtime = new Runtime();
			runtime.config = { ...runtime.config, fallbackModel: { ...FALLBACK } };

			expect(runtime.resolveModel({ model: undefined, modelRegistry: modelRegistry(), hasUI: false })).toEqual({
				ok: false,
				reason: "no model available (session has no model and no observational-memory model configured); fallback model opencode-go/deepseek-v4.1-flash not found",
			});
		});

		it("resolveFallbackModel reports unset, identical, and missing fallbacks", () => {
			const runtime = new Runtime();
			const registry = modelRegistry({ provider: "anthropic", id: "haiku" });

			expect(runtime.resolveFallbackModel({ model: undefined, modelRegistry: registry, hasUI: false })).toEqual({
				ok: false,
				reason: "no fallback model configured",
			});

			runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "haiku" }, fallbackModel: { provider: "anthropic", id: "haiku" } };
			expect(runtime.resolveFallbackModel({ model: undefined, modelRegistry: registry, hasUI: false })).toEqual({
				ok: false,
				reason: "fallback model anthropic/haiku is identical to the effective primary model",
			});

			runtime.config = { ...runtime.config, model: undefined, fallbackModel: { provider: "anthropic", id: "haiku" } };
			expect(runtime.resolveFallbackModel({ model: { provider: "anthropic", id: "haiku" }, modelRegistry: registry, hasUI: false })).toEqual({
				ok: false,
				reason: "fallback model anthropic/haiku is identical to the effective primary model",
			});

			runtime.config = { ...runtime.config, fallbackModel: { ...FALLBACK } };
			expect(runtime.resolveFallbackModel({ model: undefined, modelRegistry: registry, hasUI: false })).toEqual({
				ok: false,
				reason: "fallback model opencode-go/deepseek-v4.1-flash not found",
			});
		});

		it("resolveFallbackModel returns the registered fallback", () => {
			const runtime = new Runtime();
			runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "haiku" }, fallbackModel: { ...FALLBACK } };

			expect(runtime.resolveFallbackModel({ model: undefined, modelRegistry: modelRegistry(FALLBACK), hasUI: false })).toEqual({ ok: true, model: FALLBACK });
		});
	});
});
