/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { splitIncompleteAnsiSuffix, stripAnsi } from "../utils/ansi.ts";
import { writeOutputFileSync } from "../utils/output-files.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { OutputAccumulator } from "./tools/output-accumulator.ts";
import { headOf } from "./tools/output-head.ts";
import { headWithin, toolOutputBudgetBytes } from "./tools/output-limit.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/**
	 * Bytes of output to keep, from its start; longer output is saved whole to `fullOutputPath`.
	 * Default: the default `toolOutputMaxTokens` budget, less room for the notice.
	 */
	maxBytes?: number;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized), possibly cut to its start */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const maxBytes = options?.maxBytes ?? toolOutputBudgetBytes();
	// Lines are not limited, so output within `maxBytes` is never saved to a file.
	const output = new OutputAccumulator({ maxBytes, maxLines: Number.MAX_SAFE_INTEGER, tempFilePrefix: "pi-bash" });
	const decoder = new TextDecoder();
	// Unfinished escape sequence at the end of the previous chunk, completed by the next chunk.
	let pendingAnsi = "";

	const appendText = (rawText: string) => {
		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(rawText)).replace(/\r/g, "");
		if (!text) {
			return;
		}
		output.append(Buffer.from(text, "utf-8"));
		options?.onChunk?.(text);
	};

	const onData = (data: Buffer) => {
		const { complete, pending } = splitIncompleteAnsiSuffix(pendingAnsi + decoder.decode(data, { stream: true }));
		pendingAnsi = pending;
		appendText(complete);
	};

	const flushOutput = () => {
		const rest = pendingAnsi + decoder.decode();
		pendingAnsi = "";
		appendText(rest);
	};

	let exitCode: number | null = null;
	try {
		({ exitCode } = await operations.exec(command, cwd, { onData, signal: options?.signal }));
	} catch (err) {
		// An aborted command still returns the output it produced so far
		if (!options?.signal?.aborted) {
			await output.close();
			throw err;
		}
	}

	flushOutput();
	const { fullOutputPath } = await output.close();
	const { text, truncation } = headWithin(output.head(), maxBytes);
	const cancelled = options?.signal?.aborted ?? false;

	return {
		output: text,
		exitCode: cancelled ? undefined : (exitCode ?? undefined),
		cancelled,
		truncated: truncation.truncated,
		fullOutputPath,
	};
}

/**
 * `result` with its output cut to its start within `maxBytes`, as {@link executeBashWithOperations}
 * keeps it, for results an extension produced. Longer output is saved to a file first, unless
 * `fullOutputPath` already holds the whole output.
 */
export function limitBashResult(result: BashResult, maxBytes: number): BashResult {
	if (Buffer.byteLength(result.output, "utf-8") <= maxBytes) return result;
	return {
		...result,
		output: headWithin(headOf(result.output, maxBytes), maxBytes).text,
		truncated: true,
		fullOutputPath: result.fullOutputPath ?? writeOutputFileSync("pi-bash", ".log", result.output),
	};
}
