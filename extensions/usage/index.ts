import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	parseSnapshot,
	report,
	SOURCES,
	type Snapshot,
	shouldFetch,
	statusLine,
	type Trigger,
	type Usage,
	type UsageSource,
} from "./usage.ts";

/** The usage shown for a subscription, read at `at`; `failure` is why a later check could not replace it. */
type Entry = { usage: Usage; at: number; failure?: string };

const STATUS_KEY = "usage";
const POLL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

/**
 * Footer: usage of the Claude and Codex subscriptions pi is logged in to, per quota window.
 * `/usage` refreshes it and lists every window with its reset time.
 *
 * Usage is read from the plans' usage endpoints with the providers' OAuth tokens; no model request is made.
 * Claude also follows the quota headers of its model responses. Every known value is saved to a file per
 * subscription, so a starting or idle session shows what any session read last, and a failed check keeps it.
 */
export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	const entries = new Map<string, Entry>();
	let pending: Promise<void> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const shown = () =>
		SOURCES.flatMap((source) => {
			const entry = entries.get(source.label);
			return entry === undefined ? [] : [{ label: source.label, ...entry }];
		});

	function render(): void {
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme;
		const line = statusLine(shown(), Date.now(), (color, text) => theme.fg(color, text));
		ctx.ui.setStatus(STATUS_KEY, line === "" ? undefined : line);
	}

	function record(source: UsageSource, usage: Usage): void {
		const current = entries.get(source.label);
		if (usage.kind === "error" && current?.usage.kind === "ok") {
			entries.set(source.label, { ...current, failure: usage.message });
			return;
		}
		const at = Date.now();
		entries.set(source.label, { usage, at });
		if (usage.kind === "ok") save(source, { usage, at });
	}

	async function check(context: ExtensionContext, trigger: Trigger): Promise<void> {
		await Promise.all(
			SOURCES.map(async (source) => {
				const token = await context.modelRegistry.getApiKeyForProvider(source.provider);
				if (token === undefined) {
					entries.delete(source.label);
					return;
				}
				const saved = load(source);
				const current = entries.get(source.label);
				if (saved !== undefined && (current?.usage.kind !== "ok" || saved.at > current.at)) {
					entries.set(source.label, saved);
				}
				const known = entries.get(source.label);
				if (shouldFetch(trigger, source, known?.usage.kind === "ok" ? known.at : undefined, Date.now())) {
					record(source, await fetchUsage(source, token));
				}
			}),
		);
		render();
	}

	function poll(context: ExtensionContext): void {
		pending ??= check(context, "poll").finally(() => {
			pending = undefined;
		});
	}

	pi.on("session_start", (_event, eventCtx) => {
		ctx = eventCtx;
		if (!eventCtx.hasUI) return;
		render();
		void check(eventCtx, "start");
		timer ??= setInterval(() => {
			if (ctx) poll(ctx);
		}, POLL_MS);
		timer.unref();
	});

	pi.on("agent_settled", (_event, eventCtx) => {
		if (eventCtx.hasUI) poll(eventCtx);
	});

	pi.on("after_provider_response", (event) => {
		for (const source of SOURCES) {
			const usage = source.parseResponseHeaders?.(event.headers);
			if (usage === undefined) continue;
			record(source, usage);
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
			await check(commandCtx, "command");
			commandCtx.ui.notify(
				entries.size === 0 ? "Not logged in to a Claude or Codex subscription (/login)." : report(shown(), Date.now()),
				"info",
			);
		},
	});
}

const snapshotPath = (source: UsageSource) => join(getAgentDir(), "usage", `${source.provider}.json`);

function load(source: UsageSource): Snapshot | undefined {
	try {
		return parseSnapshot(JSON.parse(readFileSync(snapshotPath(source), "utf8")), Date.now());
	} catch {
		// No session has saved a value yet, or the file is unreadable: the endpoint decides.
		return undefined;
	}
}

/** Written whole and renamed, so a reading session never sees a partial file; the last writer wins. */
function save(source: UsageSource, snapshot: Snapshot): void {
	const path = snapshotPath(source);
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, JSON.stringify(snapshot));
		renameSync(temporary, path);
	} catch {
		// Best effort: without the file, sessions only stop sharing values.
	}
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
