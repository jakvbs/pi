// How tool output is bounded: one module the harness and the tools share, with no runtime imports, so a tool that
// declares its limits does not pull in the harness.

import type { OutputLimits } from "@earendil-works/chord/output";
import type { Settings, ToolRegistration } from "./types.ts";

/** Bytes of an estimated token, as the coding agent counts them for its tool output limit. */
const BYTES_PER_TOKEN = 4;

/** Lines are not limited unless a tool limits them, as the coding agent does not limit them. */
const NO_LINE_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * A tool's declared output limits within the settings' `toolOutputMaxTokens`, which a tool may only lower; the defaults
 * when it declares none (or did not resolve).
 */
export function outputLimits(declared: ToolRegistration["outputLimits"], settings: Settings): OutputLimits {
	const maxBytes = settings.toolOutputMaxTokens * BYTES_PER_TOKEN;
	return {
		maxBytes: Math.min(declared?.maxBytes ?? maxBytes, maxBytes),
		maxLines: declared?.maxLines ?? NO_LINE_LIMIT,
		retain: declared?.retain ?? "head",
	};
}

/** The output limits the `bash` and `powershell` tools declare: the end of the output is kept. */
export const SHELL_OUTPUT_LIMITS = { retain: "tail" } as const satisfies ToolRegistration["outputLimits"];

/** The limits of the shell tools' output under `settings` (`Harness.shellOutputLimits()`). */
export function shellOutputLimits(settings: Settings): OutputLimits {
	return outputLimits(SHELL_OUTPUT_LIMITS, settings);
}
