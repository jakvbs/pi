import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { report, SOURCES, statusLine, type Usage, type UsageSource } from "./usage.ts";

/** `usage` is undefined when pi has no credentials for the subscription. */
type Result = { label: string; usage: Usage | undefined };

const STATUS_KEY = "usage";
const POLL_MS = 5 * 60_000;
/** Back-to-back runs would otherwise check usage after each one. */
const MIN_REFRESH_MS = 30_000;
const TIMEOUT_MS = 10_000;
/** Claude's usage endpoint answers 429 when every session polls it; its model responses carry the usage. */
const POLLED = SOURCES.filter((source) => source.parseResponseHeaders === undefined);

/**
 * Footer: usage of the Claude and Codex subscriptions pi is logged in to, per quota window.
 * `/usage` refreshes it and lists every window with its reset time.
 *
 * Usage is read from the plans' usage endpoints with the providers' OAuth tokens at session start and by
 * `/usage`; no model request is made. Afterwards Claude follows the quota headers of its model responses,
 * and Codex is checked after agent runs and every five minutes.
 */
export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	/** Keyed by label; the first check inserts the subscriptions in `SOURCES` order. */
	const results = new Map<string, { label: string; usage: Usage }>();
	let checkedAt = 0;
	let pending: Promise<void> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	function render(): void {
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme;
		const line = statusLine([...results.values()], Date.now(), (color, text) => theme.fg(color, text));
		ctx.ui.setStatus(STATUS_KEY, line === "" ? undefined : line);
	}

	async function update(context: ExtensionContext, sources: readonly UsageSource[]): Promise<void> {
		for (const { label, usage } of await check(context, sources)) {
			if (usage === undefined) results.delete(label);
			else results.set(label, { label, usage });
		}
		checkedAt = Date.now();
		render();
	}

	function poll(context: ExtensionContext): void {
		pending ??= update(context, POLLED).finally(() => {
			pending = undefined;
		});
	}

	pi.on("session_start", (_event, eventCtx) => {
		ctx = eventCtx;
		if (!eventCtx.hasUI) return;
		render();
		void update(eventCtx, SOURCES);
		timer ??= setInterval(() => {
			if (ctx) poll(ctx);
		}, POLL_MS);
		timer.unref();
	});

	pi.on("agent_settled", (_event, eventCtx) => {
		if (eventCtx.hasUI && Date.now() - checkedAt >= MIN_REFRESH_MS) poll(eventCtx);
	});

	pi.on("after_provider_response", (event) => {
		for (const source of SOURCES) {
			const usage = source.parseResponseHeaders?.(event.headers);
			if (usage === undefined) continue;
			results.set(source.label, { label: source.label, usage });
			render();
		}
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
			await update(commandCtx, SOURCES);
			commandCtx.ui.notify(
				results.size === 0
					? "Not logged in to a Claude or Codex subscription (/login)."
					: report([...results.values()], Date.now()),
				"info",
			);
		},
	});
}

function check(context: ExtensionContext, sources: readonly UsageSource[]): Promise<Result[]> {
	return Promise.all(
		sources.map(async (source) => {
			const token = await context.modelRegistry.getApiKeyForProvider(source.provider);
			return { label: source.label, usage: token === undefined ? undefined : await fetchUsage(source, token) };
		}),
	);
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
