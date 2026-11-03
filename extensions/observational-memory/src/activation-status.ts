// Footer status: how close the context Pi reports is to memory activation.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveCompactAfterTokens } from "./config.ts";
import type { Runtime } from "./runtime.ts";

export const ACTIVATION_STATUS_KEY = "observational-memory";

/**
 * Show `compact N%` in the footer: the context Pi reports (the same reading
 * activation compares) as a share of the activation threshold. Hidden when
 * memory is passive or the threshold does not fit the model's context window,
 * since Pi's own compaction comes first there.
 */
export function registerActivationStatus(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_start", (_event, ctx) => renderActivationStatus(runtime, ctx));
	pi.on("model_select", (_event, ctx) => renderActivationStatus(runtime, ctx));
	pi.on("session_tree", (_event, ctx) => renderActivationStatus(runtime, ctx));
	pi.on("session_compact", (_event, ctx) => renderActivationStatus(runtime, ctx));
	// Activation's handler runs first; a compaction it proposes is persisted
	// after the handlers, and Pi knows the new context size only after the next reply.
	pi.on("turn_end", (event, ctx) => {
		renderActivationStatus(runtime, ctx, event.entries.some((entry) => entry.type === "compaction"));
		return undefined;
	});
}

export function renderActivationStatus(runtime: Runtime, ctx: ExtensionContext, compactionPending = false): void {
	if (!ctx.hasUI) return;
	runtime.ensureConfig(ctx.cwd);
	const usage = ctx.getContextUsage();
	const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
	const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
	if (runtime.config.passive === true || usage === undefined || threshold >= usage.contextWindow) {
		ctx.ui.setStatus(ACTIVATION_STATUS_KEY, undefined);
		return;
	}
	const progress =
		compactionPending || usage.tokens === null ? "?" : `${Math.round((usage.tokens / threshold) * 100)}%`;
	ctx.ui.setStatus(ACTIVATION_STATUS_KEY, ctx.ui.theme.fg("dim", `compact ${progress}`));
}
