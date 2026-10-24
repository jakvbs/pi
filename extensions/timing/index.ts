import type { ExtensionAPI, ExtensionContext, MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import {
	appendStamp,
	endsRun,
	formatClock,
	formatDuration,
	lastText,
	responseLabel,
	runDuration,
	runStart,
	userText,
} from "./timing.ts";

const STATUS_KEY = "timing";

/**
 * Footer: elapsed time of the current run, shown only while it runs.
 * Transcript: send time under user messages, completion time under responses, and the run duration under
 * the response that ends a run.
 *
 * Stamps are derived from timestamps Pi already stores in the session, so old sessions get them too and
 * the extension writes no entries of its own.
 */
export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let runStartedAt: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	// Live transcript components carry no session-entry id, so their Markdown is matched by text.
	const liveUserSentAt = new Map<string, number>();
	const liveResponseLabels = new Map<string, string>();

	const getEntry = (id: string) => ctx?.sessionManager.getEntry(id);

	function persistedLabel(messageId: string, markdown: string, context: MarkdownTransformContext): string | undefined {
		const entry = getEntry(messageId);
		if (entry?.type !== "message") return undefined;
		const message = entry.message;
		if (context.messageType === "user" && message.role === "user") {
			return formatClock(message.timestamp, Date.now());
		}
		if (
			context.messageType === "assistant" &&
			message.role === "assistant" &&
			lastText(message.content) === markdown
		) {
			return responseLabel(Date.parse(entry.timestamp), runDuration(entry, getEntry), Date.now());
		}
		return undefined;
	}

	function liveLabel(markdown: string, context: MarkdownTransformContext): string | undefined {
		if (context.messageType === "assistant") return liveResponseLabels.get(markdown);
		// A skill invocation renders only the user's text after the skill block.
		const sentAt = liveUserSentAt.get(markdown) ?? [...liveUserSentAt].find(([text]) => text.endsWith(markdown))?.[1];
		return sentAt === undefined ? undefined : formatClock(sentAt, Date.now());
	}

	pi.registerMarkdownTransformer((markdown, context) => {
		const theme = ctx?.ui.theme;
		if (!theme || context.isStreaming || context.messageType === "assistant-thinking") return markdown;
		const label = context.messageId
			? persistedLabel(context.messageId, markdown, context)
			: liveLabel(markdown, context);
		return label ? appendStamp(markdown, label, context.availableWidth, (text) => theme.fg("dim", text)) : markdown;
	});

	function renderStatus(): void {
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme;
		const status =
			runStartedAt === undefined
				? undefined
				: `${theme.fg("accent", "●")} ${theme.fg("text", formatDuration(Date.now() - runStartedAt))}`;
		ctx.ui.setStatus(STATUS_KEY, status);
	}

	function stopTimer(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	pi.on("session_start", (_event, eventCtx) => {
		ctx = eventCtx;
		liveUserSentAt.clear();
		liveResponseLabels.clear();
		stopTimer();
		runStartedAt = undefined;
		// A reload can happen mid-run; the session tree still knows when that run started.
		if (!eventCtx.isIdle()) {
			runStartedAt = runStart(eventCtx.sessionManager.getLeafId(), getEntry) ?? Date.now();
			if (eventCtx.hasUI) timer = setInterval(renderStatus, 1000);
		}
		renderStatus();
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "user") liveUserSentAt.set(userText(event.message.content), event.message.timestamp);
	});

	// Extensions see message_end before the transcript finalizes the streamed component and before the
	// entry is appended, so the current leaf is the entry preceding this response.
	pi.on("message_end", (event, eventCtx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		const text = lastText(message.content);
		if (!text) return;
		const completedAt = Date.now();
		const start = endsRun(message.stopReason) ? runStart(eventCtx.sessionManager.getLeafId(), getEntry) : undefined;
		const runMs = start === undefined ? undefined : Math.max(0, completedAt - start);
		liveResponseLabels.set(text, responseLabel(completedAt, runMs, completedAt));
	});

	pi.on("agent_start", (_event, eventCtx) => {
		ctx = eventCtx;
		if (runStartedAt !== undefined) return;
		runStartedAt = Date.now();
		if (eventCtx.hasUI) timer = setInterval(renderStatus, 1000);
		renderStatus();
	});

	pi.on("agent_settled", (_event, eventCtx) => {
		ctx = eventCtx;
		stopTimer();
		runStartedAt = undefined;
		renderStatus();
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx = undefined;
	});
}
