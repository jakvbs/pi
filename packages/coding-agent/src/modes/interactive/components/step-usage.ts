// What each step of a run adds to the model's context window and what its model call costs, as the transcript shows
// it on the step's first tool row, on a reply, and summed on a turn's fold row.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { formatTokens } from "./footer.ts";

/** What one step, a model call and the tool calls it made, added to the context window, and what the call cost. */
export interface StepUsage {
	/**
	 * Tokens the step added. For a reply its output; for a call that used tools also the tool results and any message
	 * added before the next call, known once that call reports its input. Undefined until then, and for good when a
	 * compaction comes between.
	 */
	added: number | undefined;
	/** Undefined for a subscription, whose cost is only an estimate of API pricing. */
	cost: number | undefined;
}

/**
 * Measures the steps of one transcript in order. The input of a call minus the input of the call before it is what
 * the step before it added. A compaction, a branch summary or a new transcript starts over, because the input shrinks
 * there.
 */
export class StepMeter {
	/** The last call that used tools, whose step the next call completes. */
	private open: { input: number; usage: StepUsage } | undefined;

	/** Start over: nothing measured so far completes a step measured later. */
	reset(): void {
		this.open = undefined;
	}

	/**
	 * Measure a finished call and complete the open step, which the returned usage objects show at their next render.
	 * Undefined for a call without usage, such as an aborted or failed one; the call after it completes the open step.
	 */
	measure(message: AssistantMessage, showsCost: boolean): StepUsage | undefined {
		const { usage } = message;
		const input = usage.input + usage.cacheRead + usage.cacheWrite;
		if (message.stopReason === "aborted" || message.stopReason === "error" || input + usage.output === 0) {
			return undefined;
		}
		if (this.open) this.open.usage.added = input - this.open.input;
		const usesTools = message.stopReason === "toolUse";
		const step: StepUsage = {
			added: usesTools ? undefined : usage.output,
			cost: showsCost ? usage.cost.total : undefined,
		};
		this.open = usesTools ? { input, usage: step } : undefined;
		return step;
	}
}

/** Usage as a row shows it, for example `+9.7k ctx · $0.073`; empty when it has neither part. */
export function formatUsage({ added, cost }: StepUsage): string {
	const parts: string[] = [];
	if (added !== undefined) parts.push(`${added < 0 ? "-" : "+"}${formatTokens(Math.abs(added))} ctx`);
	if (cost !== undefined && cost > 0) parts.push(`$${cost.toFixed(3)}`);
	return parts.join(" · ");
}

/** The usage of several steps together; a part known for none of them stays undefined. */
export function sumUsage(steps: readonly StepUsage[]): StepUsage {
	const total: StepUsage = { added: undefined, cost: undefined };
	for (const step of steps) {
		if (step.added !== undefined) total.added = (total.added ?? 0) + step.added;
		if (step.cost !== undefined) total.cost = (total.cost ?? 0) + step.cost;
	}
	return total;
}
