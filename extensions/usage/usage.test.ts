import assert from "node:assert/strict";
import { test } from "node:test";
import {
	codexAccountId,
	parseClaudeHeaders,
	parseClaudeUsage,
	parseCodexUsage,
	parseSnapshot,
	report,
	SOURCES,
	shouldFetch,
	statusLine,
} from "./usage.ts";

const NOW = Date.parse("2026-11-04T07:00:00Z");

// Trimmed responses of the live endpoints, 2026-11-04.
const CLAUDE = {
	five_hour: null,
	seven_day: { utilization: 47.0, resets_at: "2026-11-07T08:00:00.294030+00:00", limit_dollars: null },
	seven_day_opus: null,
	extra_usage: { is_enabled: false, monthly_limit: null },
};
const CODEX = {
	plan_type: "pro",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 604623, reset_at: 1794379576 },
		secondary_window: null,
	},
	credits: { has_credits: true, unlimited: false, balance: "62500.0000000000" },
};

const brackets = (color: string, text: string) => `[${color}:${text}]`;

test("Claude windows come from five_hour and seven_day; a null window is absent", () => {
	assert.deepEqual(parseClaudeUsage(CLAUDE), {
		kind: "ok",
		windows: [{ label: "7d", percent: 47, resetsAt: Date.parse("2026-11-07T08:00:00.294Z") }],
		limited: false,
	});
	assert.deepEqual(
		parseClaudeUsage({ five_hour: { utilization: 100, resets_at: "2026-11-04T09:00:00Z" }, seven_day: null }),
		{ kind: "ok", windows: [{ label: "5h", percent: 100, resetsAt: Date.parse("2026-11-04T09:00:00Z") }], limited: true },
	);
	assert.deepEqual(parseClaudeUsage({ error: "x" }), { kind: "error", message: "no usage windows in the response" });
});

test("Claude windows also come from the quota headers of a model response", () => {
	// Trimmed headers of a live pi-sub-anthropic response, 2026-11-04.
	const headers = {
		"content-type": "text/event-stream",
		"anthropic-ratelimit-unified-status": "allowed",
		"anthropic-ratelimit-unified-representative-claim": "seven_day",
		"anthropic-ratelimit-unified-7d-status": "allowed",
		"anthropic-ratelimit-unified-7d-utilization": "0.49",
		"anthropic-ratelimit-unified-7d-reset": "1794038400",
	};
	assert.deepEqual(parseClaudeHeaders(headers), {
		kind: "ok",
		windows: [{ label: "7d", percent: 49, resetsAt: Date.parse("2026-11-07T08:00:00Z") }],
		limited: false,
	});
	// The 5h names follow the 7d ones; the live response had no 5h window, like the endpoint.
	assert.deepEqual(
		parseClaudeHeaders({ "anthropic-ratelimit-unified-5h-utilization": "1", "anthropic-ratelimit-unified-5h-reset": "1794000000" }),
		{ kind: "ok", windows: [{ label: "5h", percent: 100, resetsAt: 1794000000000 }], limited: true },
	);
	assert.equal(parseClaudeHeaders({ "content-type": "text/event-stream" }), undefined);
});

test("Codex windows are labelled by their length", () => {
	assert.deepEqual(parseCodexUsage(CODEX), {
		kind: "ok",
		windows: [{ label: "7d", percent: 0, resetsAt: 1794379576000 }],
		limited: false,
	});
	const plus = {
		rate_limit: {
			allowed: false,
			limit_reached: true,
			primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 1794000000 },
			secondary_window: { used_percent: 40, limit_window_seconds: 604800 },
		},
	};
	assert.deepEqual(parseCodexUsage(plus), {
		kind: "ok",
		windows: [
			{ label: "5h", percent: 100, resetsAt: 1794000000000 },
			{ label: "7d", percent: 40, resetsAt: undefined },
		],
		limited: true,
	});
});

test("the Codex account id is read from the access token", () => {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }));
	assert.equal(codexAccountId(`h.${payload.toString("base64url")}.s`), "acc-1");
	assert.throws(() => codexAccountId(`h.${Buffer.from("{}").toString("base64url")}.s`), /no ChatGPT account id/);
});

test("the footer shows reset times only for windows close to their limit", () => {
	const results = [
		{
			label: "Claude",
			usage: {
				kind: "ok" as const,
				windows: [
					{ label: "5h", percent: 12.4, resetsAt: NOW + 3_600_000 },
					{ label: "7d", percent: 81, resetsAt: NOW + 2 * 3_600_000 + 5 * 60_000 },
				],
				limited: false,
			},
		},
		{ label: "Codex", usage: { kind: "error" as const, message: "HTTP 401" } },
	];
	assert.equal(
		statusLine(results, NOW, brackets),
		"[dim:Claude] [dim:5h] [text:12%] [dim:7d] [warning:81%][dim: reset 2h5m][dim: · ][dim:Codex] [warning:?]",
	);
	assert.equal(statusLine([], NOW, brackets), "");
});

test("/usage lists every window with its reset time", () => {
	const results = [
		{ label: "Claude", usage: parseClaudeUsage(CLAUDE), at: NOW },
		{ label: "Codex", usage: { kind: "error" as const, message: "HTTP 401" }, at: NOW },
	];
	assert.equal(report(results, NOW), "Claude\n  7d 47%, resets in 3d1h (Sat 08:00)\nCodex: HTTP 401");
});

test("/usage names a failed check that kept an earlier value", () => {
	const results = [{ label: "Claude", usage: parseClaudeUsage(CLAUDE), at: NOW - 4 * 60_000, failure: "HTTP 429" }];
	assert.equal(
		report(results, NOW),
		"Claude (check failed: HTTP 429; usage from 4m ago)\n  7d 47%, resets in 3d1h (Sat 08:00)",
	);
});

test("a saved snapshot keeps only windows that have not reset", () => {
	const saved = JSON.parse(
		JSON.stringify({
			at: NOW - 60_000,
			usage: {
				kind: "ok",
				windows: [
					{ label: "5h", percent: 80, resetsAt: NOW - 1 },
					{ label: "7d", percent: 49, resetsAt: NOW + 3_600_000 },
					{ label: "window", percent: 3, resetsAt: undefined },
				],
				limited: false,
			},
		}),
	);
	assert.deepEqual(parseSnapshot(saved, NOW), {
		at: NOW - 60_000,
		usage: {
			kind: "ok",
			windows: [
				{ label: "7d", percent: 49, resetsAt: NOW + 3_600_000 },
				{ label: "window", percent: 3, resetsAt: undefined },
			],
			limited: false,
		},
	});
	assert.equal(parseSnapshot({ at: NOW, usage: { kind: "ok", windows: [{ label: "5h", percent: 80, resetsAt: NOW }] } }, NOW), undefined);
	assert.equal(parseSnapshot({ at: NOW, usage: { kind: "error", message: "HTTP 429" } }, NOW), undefined);
	assert.equal(parseSnapshot("not json object", NOW), undefined);
});

test("checks read an endpoint only when no current value is known", () => {
	const [claude, codex] = SOURCES;
	const minutes = (n: number) => NOW - n * 60_000;
	const cases = [
		["start", claude, undefined, true],
		["start", claude, minutes(4), false],
		["start", claude, minutes(6), true],
		["start", codex, minutes(4), false],
		["poll", claude, undefined, false],
		["poll", claude, minutes(60), false],
		["poll", codex, minutes(0.25), false],
		["poll", codex, minutes(1), true],
		["command", claude, minutes(0), true],
	] as const;
	for (const [trigger, source, knownAt, expected] of cases) {
		assert.equal(shouldFetch(trigger, source, knownAt, NOW), expected, `${trigger} ${source.label} ${knownAt}`);
	}
});
