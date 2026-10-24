import type { ConsolidationPhase } from "./runtime.ts";

/** A condition of the memory model or a memory stage that the user is warned about. */
export type WarningCondition =
	| "consolidation failed"
	| "no model"
	| "configured model missing"
	| "primary model unavailable"
	| `${ConsolidationPhase} primary failed`
	| `${ConsolidationPhase} failed`;

export interface WarningCtx {
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
}

/**
 * Warnings about conditions that outlast one memory pass. A pass starts again after every turn
 * while a stage is due, and a failed stage stays due, so a lasting failure would repeat its
 * warning on every turn. Each condition is shown once while it holds, and again only after it
 * cleared and came back. `/om:status` shows the latest stage errors in between.
 */
export class Warnings {
	private readonly shown = new Set<WarningCondition>();

	warn(ctx: WarningCtx, condition: WarningCondition, message: string): void {
		if (this.shown.has(condition)) return;
		this.shown.add(condition);
		if (ctx.hasUI && ctx.ui) ctx.ui.notify(message, "warning");
	}

	/** The condition no longer holds: warn again when it recurs. */
	clear(condition: WarningCondition): void {
		this.shown.delete(condition);
	}
}
