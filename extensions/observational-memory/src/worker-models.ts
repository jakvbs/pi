import type { WorkerModelRegistry } from "./agents/worker-stream.ts";
import { debugLog } from "./debug-log.ts";
import type { ConsolidationPhase, ResolveCtx, ResolveResult, Runtime } from "./runtime.ts";

/**
 * Model choice for one memory pass, shared by background consolidation and the compaction
 * catch-up: resolve the primary once, retry a failed stage once with the configured fallback,
 * and keep the fallback for the rest of the pass once it took over.
 */

export type ResolvedModel = Extract<ResolveResult, { ok: true }>;

/** The parts of an extension context a memory pass needs to choose and call its model. */
export type WorkerModelCtx = {
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: WorkerModelRegistry & ResolveCtx["modelRegistry"];
};

/** Thinking level for the worker call: the fallback's own setting wins when the fallback is active. */
export function workerThinkingLevel(runtime: Runtime, resolved: ResolvedModel) {
	if (resolved.fallbackUsed === true) {
		return runtime.config.fallbackModel?.thinking ?? runtime.config.model?.thinking ?? "low";
	}
	return runtime.config.model?.thinking ?? "low";
}

/**
 * Context window the observer chunk is sized against. The chunk is serialized
 * once and reused verbatim if the run falls back mid-call, so cap it to the
 * smaller of the primary and fallback windows: otherwise a large-context primary
 * plus a small-context fallback would send the fallback an over-context chunk and
 * make the retry fail for a reason the fallback cannot fix. When no fallback is
 * configured this is exactly the primary model's window.
 */
export function observerChunkContextWindow(runtime: Runtime, ctx: WorkerModelCtx, resolved: ResolvedModel): number | undefined {
	const primary = (resolved.model as { contextWindow?: number } | undefined)?.contextWindow;
	const fallback = runtime.config.fallbackModel;
	if (!fallback) return primary;
	const fallbackModel = ctx.modelRegistry.find(fallback.provider, fallback.id) as { contextWindow?: number } | undefined;
	const usablePrimary = typeof primary === "number" && primary > 0 ? primary : undefined;
	const fallbackWindow = fallbackModel?.contextWindow;
	const usableFallback = typeof fallbackWindow === "number" && fallbackWindow > 0 ? fallbackWindow : undefined;
	if (usablePrimary === undefined) return usableFallback;
	if (usableFallback === undefined) return usablePrimary;
	return Math.min(usablePrimary, usableFallback);
}

export type ModelResolver = {
	resolve: (stage: ConsolidationPhase) => Promise<ResolvedModel | undefined>;
	/** Resolve the configured fallback, caching it for the rest of the pass. */
	resolveFallback: (stage: ConsolidationPhase) => Promise<ResolvedModel | undefined>;
	/**
	 * Run one worker stage against the resolved model, retrying once with the configured
	 * fallback when the call throws. A stage that already resolved through the fallback is not
	 * retried again: its error is final. The last error thrown is what the caller sees, so the
	 * stream-error classification and failure recording stay intact.
	 */
	runStage: <T>(
		stage: ConsolidationPhase,
		resolved: ResolvedModel,
		work: (model: ResolvedModel) => Promise<T>,
		signal?: AbortSignal,
	) => Promise<T>;
};

export function makeModelResolver(runtime: Runtime, ctx: WorkerModelCtx): ModelResolver {
	let cached: ResolveResult | undefined;
	// Once the fallback proves usable, keep it for the rest of the pass so later
	// stages do not re-pay a known-broken primary.
	let fallbackActive: ResolvedModel | undefined;

	const resolve = async (stage: ConsolidationPhase): Promise<ResolvedModel | undefined> => {
		if (fallbackActive) {
			runtime.warnings.clear("no model");
			return fallbackActive;
		}
		cached ??= runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (cached.ok) {
			runtime.warnings.clear("no model");
			return cached;
		}
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		runtime.warnings.warn(ctx, "no model", `Observational memory: ${stage} skipped — ${cached.reason}`);
		return undefined;
	};

	const resolveFallback = async (stage: ConsolidationPhase): Promise<ResolvedModel | undefined> => {
		if (fallbackActive) return fallbackActive;
		const resolveFallbackModel = runtime.resolveFallbackModel;
		if (typeof resolveFallbackModel !== "function") {
			debugLog(`${stage}.fallback_unavailable`, { reason: "runtime exposes no resolveFallbackModel" });
			return undefined;
		}
		const resolvedCtx: ResolveCtx = {
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		};
		const result = resolveFallbackModel.call(runtime, resolvedCtx);
		if (!result.ok) {
			debugLog(`${stage}.fallback_unavailable`, { reason: result.reason });
			return undefined;
		}
		const resolved: ResolvedModel = { ...result, fallbackUsed: true };
		fallbackActive = resolved;
		debugLog(`${stage}.fallback_active`, {
			provider: (resolved.model as { provider?: string })?.provider,
			id: (resolved.model as { id?: string })?.id,
		});
		return resolved;
	};

	const runStage = async <T>(
		stage: ConsolidationPhase,
		resolved: ResolvedModel,
		work: (model: ResolvedModel) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> => {
		let result: T;
		try {
			result = await work(resolved);
			if (resolved.fallbackUsed !== true) runtime.warnings.clear(`${stage} primary failed`);
		} catch (primaryError) {
			// An aborted run (consolidateWhenIdle yielding to the session) is not a
			// model failure: retrying with the fallback would defeat the abort.
			if (signal?.aborted) throw primaryError;
			if (resolved.fallbackUsed === true) throw primaryError;
			const fallback = await resolveFallback(stage);
			if (!fallback) throw primaryError;
			const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
			debugLog(`${stage}.fallback_retry`, {
				primaryError: message,
				provider: (fallback.model as { provider?: string })?.provider,
				id: (fallback.model as { id?: string })?.id,
			});
			runtime.warnings.warn(
				ctx,
				`${stage} primary failed`,
				`Observational memory: ${stage} failed (${message}); retrying with fallback model`,
			);
			result = await work(fallback);
		}
		runtime.warnings.clear(`${stage} failed`);
		return result;
	};

	return { resolve, resolveFallback, runStage };
}
