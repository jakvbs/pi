// Subscription usage endpoints of Claude and Codex: requests, response parsing and footer/report text.

/** One quota window of a subscription plan. `resetsAt` is epoch ms. */
export type UsageWindow = { label: string; percent: number; resetsAt: number | undefined };

/** Result of one usage check: the plan's windows, or why they could not be read. */
export type Usage =
	| { kind: "ok"; windows: readonly UsageWindow[]; limited: boolean }
	| { kind: "error"; message: string };

/**
 * A subscription whose usage endpoint accepts the OAuth access token of a pi provider.
 * A source with `parseResponseHeaders` is updated from the headers of model responses instead of being
 * polled; its endpoint is still read at session start and by `/usage`.
 */
export type UsageSource = {
	provider: string;
	label: string;
	url: string;
	headers: (token: string) => Record<string, string>;
	parse: (body: unknown) => Usage;
	parseResponseHeaders?: (headers: Record<string, string>) => Usage | undefined;
};

export const SOURCES: readonly UsageSource[] = [
	{
		provider: "pi-sub-anthropic",
		label: "Claude",
		url: "https://api.anthropic.com/api/oauth/usage",
		headers: (token) => ({ Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }),
		parse: parseClaudeUsage,
		parseResponseHeaders: parseClaudeHeaders,
	},
	{
		provider: "openai-codex",
		label: "Codex",
		url: "https://chatgpt.com/backend-api/wham/usage",
		headers: (token) => ({ Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": codexAccountId(token) }),
		parse: parseCodexUsage,
	},
];

const field = (value: unknown, key: string): unknown =>
	typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const finite = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const CLAUDE_WINDOWS = [
	["five_hour", "5h"],
	["seven_day", "7d"],
] as const;

/** Claude reports a window as null until it has usage, so an idle 5h window is absent rather than 0%. */
export function parseClaudeUsage(body: unknown): Usage {
	const windows = CLAUDE_WINDOWS.flatMap(([key, label]): UsageWindow[] => {
		const window = field(body, key);
		const percent = finite(field(window, "utilization"));
		if (percent === undefined) return [];
		const resetsAt = field(window, "resets_at");
		return [{ label, percent, resetsAt: typeof resetsAt === "string" ? Date.parse(resetsAt) : undefined }];
	});
	if (windows.length === 0) return { kind: "error", message: "no usage windows in the response" };
	return { kind: "ok", windows, limited: windows.some((window) => window.percent >= 100) };
}

/**
 * Claude model responses carry the same windows as `anthropic-ratelimit-unified-<window>-utilization`
 * (a fraction) and `-reset` (epoch seconds). Responses without them, e.g. to an API key, are not usage.
 */
export function parseClaudeHeaders(headers: Record<string, string>): Usage | undefined {
	const number = (key: string) => finite(Number(headers[`anthropic-ratelimit-unified-${key}`]));
	const windows = CLAUDE_WINDOWS.flatMap(([, label]): UsageWindow[] => {
		const utilization = number(`${label}-utilization`);
		if (utilization === undefined) return [];
		const reset = number(`${label}-reset`);
		return [{ label, percent: utilization * 100, resetsAt: reset === undefined ? undefined : reset * 1000 }];
	});
	if (windows.length === 0) return undefined;
	return { kind: "ok", windows, limited: windows.some((window) => window.percent >= 100) };
}

/** Codex names windows primary/secondary; their length depends on the plan (Pro has only a weekly one). */
export function parseCodexUsage(body: unknown): Usage {
	const rateLimit = field(body, "rate_limit");
	const windows = ["primary_window", "secondary_window"].flatMap((key): UsageWindow[] => {
		const window = field(rateLimit, key);
		const percent = finite(field(window, "used_percent"));
		if (percent === undefined) return [];
		const resetAt = finite(field(window, "reset_at"));
		const label = windowLabel(finite(field(window, "limit_window_seconds")));
		return [{ label, percent, resetsAt: resetAt === undefined ? undefined : resetAt * 1000 }];
	});
	if (windows.length === 0) return { kind: "error", message: "no usage windows in the response" };
	const limited = field(rateLimit, "limit_reached") === true || field(rateLimit, "allowed") === false;
	return { kind: "ok", windows, limited };
}

function windowLabel(seconds: number | undefined): string {
	if (seconds === undefined) return "window";
	const hours = Math.round(seconds / 3600);
	return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

/** The Codex backend needs the ChatGPT account id, which the access token (a JWT) carries. */
export function codexAccountId(token: string): string {
	const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
	const accountId = field(field(payload, CODEX_AUTH_CLAIM), "chatgpt_account_id");
	if (typeof accountId !== "string" || accountId === "") throw new Error("no ChatGPT account id in the Codex token");
	return accountId;
}

/** Usage at or above this percent is highlighted, and its reset time is shown in the footer. */
const WARNING_PERCENT = 70;
const ERROR_PERCENT = 90;

export type Color = "dim" | "text" | "warning" | "error";
export type Paint = (color: Color, text: string) => string;

/** One footer line for all checked subscriptions, e.g. `Claude 5h 12% 7d 81% ↻2h5m · Codex 7d 3%`. */
export function statusLine(results: readonly { label: string; usage: Usage }[], now: number, paint: Paint): string {
	return results
		.map(({ label, usage }) => {
			if (usage.kind === "error") return `${paint("dim", label)} ${paint("warning", "?")}`;
			const windows = usage.windows.map((window) => {
				const color = window.percent >= ERROR_PERCENT ? "error" : window.percent >= WARNING_PERCENT ? "warning" : "text";
				const reset =
					window.percent >= WARNING_PERCENT && window.resetsAt !== undefined
						? paint("dim", ` ↻${formatRemaining(window.resetsAt - now)}`)
						: "";
				return `${paint("dim", window.label)} ${paint(color, `${Math.round(window.percent)}%`)}${reset}`;
			});
			return `${paint(usage.limited ? "error" : "dim", label)} ${windows.join(" ")}`;
		})
		.join(paint("dim", " · "));
}

/** Multi-line report for `/usage`, with every window's reset time. */
export function report(results: readonly { label: string; usage: Usage }[], now: number): string {
	return results
		.map(({ label, usage }) => {
			if (usage.kind === "error") return `${label}: ${usage.message}`;
			const windows = usage.windows.map((window) => {
				const reset =
					window.resetsAt === undefined
						? ""
						: `, resets in ${formatRemaining(window.resetsAt - now)} (${formatClock(window.resetsAt)})`;
				return `  ${window.label} ${Math.round(window.percent)}%${reset}`;
			});
			return [`${label}${usage.limited ? " (limit reached)" : ""}`, ...windows].join("\n");
		})
		.join("\n");
}

export function formatRemaining(ms: number): string {
	const minutes = Math.max(0, Math.ceil(ms / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	if (days > 0) return `${days}d${hours}h`;
	return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatClock(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
