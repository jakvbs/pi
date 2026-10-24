import { type Config, DEFAULTS, loadConfig } from "./config.ts";
import { debugLog } from "./debug-log.ts";
import { Warnings } from "./warnings.ts";

export type ResolveResult =
	| {
			ok: true;
			model: unknown;
			/** True when this result came from `config.fallbackModel` because no primary model resolved. */
			fallbackUsed?: boolean;
			/** Primary failure reason recorded when `fallbackUsed` is true. */
			primaryFailure?: string;
	  }
	| { ok: false; reason: string };

type NotifyLevel = "warning" | "info" | "error";
type Notify = (message: string, type?: NotifyLevel) => void;
export type ConsolidationPhase = "observer" | "reflector" | "dropper";

export interface ResolveCtx {
	model: unknown;
	modelRegistry: { find(provider: string, modelId: string): unknown };
	hasUI: boolean;
	ui?: { notify: Notify };
}

export interface LaunchCtx {
	hasUI: boolean;
	ui?: { notify: Notify };
}

export class Runtime {
	config: Config = { ...DEFAULTS };
	configLoaded = false;
	consolidationInFlight = false;
	consolidationPromise: Promise<void> | null = null;
	consolidationPhase: ConsolidationPhase | undefined;
	/** Aborts the in-flight consolidation run's model calls (see `consolidateWhenIdle`). */
	consolidationAbortController: AbortController | undefined;
	compactHookInFlight = false;
	readonly warnings = new Warnings();
	lastObserverError: string | undefined;
	lastReflectorError: string | undefined;
	lastDropperError: string | undefined;
	/** Deliberate-empty backoff (#23): skip observer re-fires over the same span until enough new tokens arrive. */
	observerEmptyBackoff: {
		sessionIdentity: string | undefined;
		coverageId: string | undefined;
		tokensAtEmpty: number;
	} | undefined;

	ensureConfig(cwd: string): void {
		if (this.configLoaded) return;
		this.config = loadConfig(cwd);
		this.configLoaded = true;
	}

	/**
	 * Choose the model memory workers should use. Credentials are not checked here: Pi
	 * authenticates each worker request when it is sent, and a request Pi cannot
	 * authenticate fails like any other model call, which retries with the fallback.
	 *
	 * Order: `config.model` (falling back to the session model when it is absent
	 * from Pi's registry), then `config.fallbackModel` when no primary model is
	 * available. With no fallback configured the primary reason is returned unchanged;
	 * with a configured-but-broken fallback both reasons are reported.
	 */
	resolveModel(ctx: ResolveCtx): ResolveResult {
		const primary = this.resolvePrimaryModel(ctx);
		if (primary.ok) {
			this.warnings.clear("primary model unavailable");
			return primary;
		}
		const fallback = this.resolveFallbackModel(ctx);
		if (!fallback.ok) {
			return this.config.fallbackModel
				? { ok: false, reason: `${primary.reason}; ${fallback.reason}` }
				: primary;
		}
		const target = this.config.fallbackModel;
		const provider = (fallback.model as { provider?: string }).provider ?? target?.provider ?? "unknown";
		const id = (fallback.model as { id?: string }).id ?? target?.id ?? "unknown";
		this.warnings.warn(
			ctx,
			"primary model unavailable",
			`Observational memory: primary model unavailable (${primary.reason}); using fallback ${provider}/${id}`,
		);
		debugLog("resolve.fallback_used", { provider, id, primaryFailure: primary.reason });
		return { ...fallback, fallbackUsed: true, primaryFailure: primary.reason };
	}

	/** `config.model` when it resolves in Pi's registry, otherwise the session model. */
	private resolvePrimaryModel(ctx: ResolveCtx): ResolveResult {
		let model = ctx.model;
		if (this.config.model) {
			const configured = ctx.modelRegistry.find(this.config.model.provider, this.config.model.id);
			if (configured) {
				model = configured;
				this.warnings.clear("configured model missing");
			} else {
				this.warnings.warn(
					ctx,
					"configured model missing",
					`Observational memory: configured model ${this.config.model.provider}/${this.config.model.id} not found, using session model`,
				);
			}
		}
		if (!model) return { ok: false, reason: "no model available (session has no model and no observational-memory model configured)" };
		return { ok: true, model };
	}

	/**
	 * Resolve `config.fallbackModel`. Exposed so the consolidation stages can retry a
	 * failed model call once. Returns `ok: false` when unset, identical to the
	 * effective primary, or absent from the registry.
	 */
	resolveFallbackModel(ctx: ResolveCtx): ResolveResult {
		const target = this.config.fallbackModel;
		if (!target) return { ok: false, reason: "no fallback model configured" };
		// Misconfiguration guard: a fallback identical to the effective primary would
		// re-run the exact failure instead of adding a second chance. The effective
		// primary is the configured model when it resolves, else the session model,
		// matching `resolvePrimaryModel`.
		const configured = this.config.model;
		const configuredResolved = configured
			? (ctx.modelRegistry.find(configured.provider, configured.id) as { provider?: string; id?: string } | undefined)
			: undefined;
		const effectivePrimary = (configuredResolved ?? (ctx.model as { provider?: string; id?: string } | undefined));
		if (effectivePrimary && effectivePrimary.provider === target.provider && effectivePrimary.id === target.id) {
			return { ok: false, reason: `fallback model ${target.provider}/${target.id} is identical to the effective primary model` };
		}
		const model = ctx.modelRegistry.find(target.provider, target.id);
		if (!model) return { ok: false, reason: `fallback model ${target.provider}/${target.id} not found` };
		return { ok: true, model };
	}

	launchConsolidationTask(ctx: LaunchCtx, work: () => Promise<void>): Promise<void> {
		this.consolidationInFlight = true;
		this.consolidationPhase = undefined;
		this.lastObserverError = undefined;
		this.lastReflectorError = undefined;
		this.lastDropperError = undefined;
		const controller = new AbortController();
		this.consolidationAbortController = controller;
		const promise = this.launchTrackedTask(ctx, work, () => {
			this.consolidationInFlight = false;
			this.consolidationPhase = undefined;
			if (this.consolidationAbortController === controller) this.consolidationAbortController = undefined;
			if (this.consolidationPromise === promise) this.consolidationPromise = null;
		});
		this.consolidationPromise = promise;
		return promise;
	}

	/** Abort the in-flight consolidation run, if any. Returns true when one was running. */
	abortConsolidation(): boolean {
		const controller = this.consolidationAbortController;
		if (!controller || !this.consolidationInFlight) return false;
		controller.abort();
		return true;
	}

	recordConsolidationStageError(ctx: LaunchCtx, phase: ConsolidationPhase, error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		if (phase === "observer") this.lastObserverError = message;
		if (phase === "reflector") this.lastReflectorError = message;
		if (phase === "dropper") this.lastDropperError = message;
		this.warnings.warn(ctx, `${phase} failed`, `Observational memory: ${phase} failed: ${message}`);
		return message;
	}

	private launchTrackedTask(
		ctx: LaunchCtx,
		work: () => Promise<void>,
		onFinally: (error: string | undefined) => void,
	): Promise<void> {
		// The context can go stale while the pass runs; keep what reporting needs.
		const reportTo: LaunchCtx = { hasUI: ctx.hasUI, ui: ctx.ui };
		return (async () => {
			let errorMessage: string | undefined;
			try {
				await work();
				this.warnings.clear("consolidation failed");
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : String(error);
				this.warnings.warn(reportTo, "consolidation failed", `Observational memory: consolidation failed: ${errorMessage}`);
			} finally {
				onFinally(errorMessage);
			}
		})();
	}
}
