import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { report, SOURCES, statusLine, type Usage, type UsageSource } from "./usage.ts";

type Result = { label: string; usage: Usage };

const STATUS_KEY = "usage";
const POLL_MS = 5 * 60_000;
/** Back-to-back runs would otherwise check usage after each one. */
const MIN_REFRESH_MS = 30_000;
const TIMEOUT_MS = 10_000;

/**
 * Footer: usage of the Claude and Codex subscriptions pi is logged in to, per quota window.
 * `/usage` refreshes it and lists every window with its reset time.
 *
 * Usage is read from the plans' usage endpoints with the providers' OAuth tokens; no model request is
 * made. It is checked at session start, after agent runs and every five minutes.
 */
export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let results: readonly Result[] = [];
	let checkedAt = 0;
	let pending: Promise<void> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	function render(): void {
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme;
		const line = statusLine(results, Date.now(), (color, text) => theme.fg(color, text));
		ctx.ui.setStatus(STATUS_KEY, line === "" ? undefined : line);
	}

	function refresh(context: ExtensionContext): Promise<void> {
		pending ??= check(context)
			.then((checked) => {
				results = checked;
				checkedAt = Date.now();
				render();
			})
			.finally(() => {
				pending = undefined;
			});
		return pending;
	}

	pi.on("session_start", (_event, eventCtx) => {
		ctx = eventCtx;
		if (!eventCtx.hasUI) return;
		render();
		void refresh(eventCtx);
		timer ??= setInterval(() => {
			if (ctx) void refresh(ctx);
		}, POLL_MS);
		timer.unref();
	});

	pi.on("agent_settled", (_event, eventCtx) => {
		if (eventCtx.hasUI && Date.now() - checkedAt >= MIN_REFRESH_MS) void refresh(eventCtx);
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx = undefined;
	});

	pi.registerCommand("usage", {
		description: "Show Claude and Codex subscription usage",
		handler: async (_args, commandCtx) => {
			await refresh(commandCtx);
			commandCtx.ui.notify(
				results.length === 0 ? "Not logged in to a Claude or Codex subscription (/login)." : report(results, Date.now()),
				"info",
			);
		},
	});
}

async function check(context: ExtensionContext): Promise<Result[]> {
	const checked = await Promise.all(
		SOURCES.map(async (source) => {
			const token = await context.modelRegistry.getApiKeyForProvider(source.provider);
			return token === undefined ? undefined : { label: source.label, usage: await fetchUsage(source, token) };
		}),
	);
	return checked.filter((result) => result !== undefined);
}

async function fetchUsage(source: UsageSource, token: string): Promise<Usage> {
	try {
		const response = await fetch(source.url, {
			headers: source.headers(token),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!response.ok) return { kind: "error", message: `HTTP ${response.status}` };
		return source.parse(await response.json());
	} catch (error) {
		return { kind: "error", message: error instanceof Error ? error.message : String(error) };
	}
}
