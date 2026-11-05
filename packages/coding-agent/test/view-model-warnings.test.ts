import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { main } from "../src/main.ts";
import type { InteractiveModeOptions } from "../src/modes/interactive/interactive-mode.ts";

const { started } = vi.hoisted(() => ({ started: vi.fn() }));

vi.mock("../src/modes/index.ts", () => ({
	InteractiveMode: class {
		private runtime: AgentSessionRuntime;

		constructor(runtime: AgentSessionRuntime, options: InteractiveModeOptions) {
			this.runtime = runtime;
			started(options);
		}

		async run() {
			await this.runtime.dispose();
		}
	},
}));

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	started.mockClear();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("view model warnings", () => {
	it.each([true, false])("skips model resolution only in a view (view=%s)", async (view) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-view-model-warnings-"));
		tempDirs.push(dir);
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				enabledModels: ["pi-sub-anthropic/claude-opus-5-5"],
				defaultProvider: "pi-sub-anthropic",
				defaultModel: "claude-opus-5-5",
			}),
		);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					faux: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						apiKey: "faux-key",
						models: [{ id: "local", name: "Local faux", contextWindow: 4096, maxTokens: 128 }],
					},
				},
			}),
		);
		const file = join(dir, "session.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: "view-warnings", timestamp: new Date().toISOString(), cwd: dir })}\n`,
		);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("PI_SKIP_VERSION_CHECK", "1");
		const stderr = vi.spyOn(console, "warn").mockImplementation(() => {});
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "cwd").mockReturnValue(dir);
		const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		try {
			await main(
				view
					? ["--view", file, "--model", "missing-provider/missing-model", "--api-key", "unused"]
					: ["--no-extensions", "--no-mcp", "--no-session", "--model", "faux/local"],
			);
			const output = [...stderr.mock.calls, ...errors.mock.calls].flat().join("\n");
			expect(started.mock.calls).toHaveLength(1);
			if (view) {
				expect(output).not.toContain("No models match pattern");
				expect(output).toBe("");
				expect(started.mock.calls[0][0]).toMatchObject({ modelFallbackMessage: undefined });
			} else {
				expect(output).toContain('Warning: No models match pattern "pi-sub-anthropic/claude-opus-5-5"');
			}
		} finally {
			if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
			else Reflect.deleteProperty(process.stdin, "isTTY");
			if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}
	});
});
