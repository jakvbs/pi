// Reads the extension's settings from the `turn-handoff` key of pi's global and project settings.json.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Cadence } from "./tracker.ts";

export const SETTINGS_KEY = "turn-handoff";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The settings: which model writes handoffs, and how often a running turn gets one. */
export interface HandoffConfig extends Cadence {
	model: { provider: string; id: string; thinking: (typeof THINKING_LEVELS)[number] } | undefined;
}

const DEFAULTS: HandoffConfig = { model: undefined, everyMs: 60_000, everyToolCalls: 8 };

/** The settings of the project in `cwd` over the global ones; a value of the wrong type keeps the default. */
export function loadConfig(cwd: string): HandoffConfig {
	const merged = { ...DEFAULTS };
	for (const path of [join(getAgentDir(), "settings.json"), join(cwd, ".pi", "settings.json")]) {
		Object.assign(merged, readSection(path));
	}
	return merged;
}

/** The fields of one settings file's section that are valid. */
function readSection(path: string): Partial<HandoffConfig> {
	if (!existsSync(path)) return {};
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
	if (typeof raw !== "object" || raw === null || !(SETTINGS_KEY in raw)) return {};
	const section: unknown = raw[SETTINGS_KEY];
	if (typeof section !== "object" || section === null) return {};
	const result: Partial<HandoffConfig> = {};
	if ("everySeconds" in section && isPositive(section.everySeconds)) result.everyMs = section.everySeconds * 1000;
	if ("everyToolCalls" in section && isPositive(section.everyToolCalls))
		result.everyToolCalls = section.everyToolCalls;
	if ("model" in section && typeof section.model === "object" && section.model !== null) {
		const model = section.model;
		const provider = "provider" in model && typeof model.provider === "string" ? model.provider : undefined;
		const id = "id" in model && typeof model.id === "string" ? model.id : undefined;
		const thinking =
			"thinking" in model ? (THINKING_LEVELS.find((level) => level === model.thinking) ?? "off") : "off";
		if (provider && id) result.model = { provider, id, thinking };
	}
	return result;
}

function isPositive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
