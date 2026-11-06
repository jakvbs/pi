import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	/** Requests answered before `usage`, each with the same usage. */
	earlierRequests?: number;
	contextTokens?: number | null;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	usingSubscription?: boolean;
	persisted?: boolean;
	routedModel?: { model: { id: string }; thinkingLevel?: string };
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		for (let i = 0; i < (options.earlierRequests ?? 0); i++) {
			entries.push({ type: "message", message: { role: "assistant", usage } });
		}
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getEntryCount: () => entries.length,
			getSessionId: () => "test-session",
			isPersisted: () => options.persisted ?? true,
			getLeafId: () => null,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({
			tokens: options.contextTokens ?? null,
			contextWindow: 200_000,
			percent: ((options.contextTokens ?? 0) / 200_000) * 100,
		}),
		routedModel: options.routedModel,
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(
	sharedModelIds: readonly string[],
	statuses: Record<string, string> = {},
): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(Object.entries(statuses)),
		isModelIdShared: (modelId: string) => sharedModelIds.includes(modelId),
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData([]));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows the session ID after the branch and session name", () => {
		const session = createSession({ sessionName: "release" });
		const footer = new FooterComponent(session, createFooterData([]));

		expect(stripAnsi(footer.render(200)[0]!).trimEnd()).toMatch(/ \(main\) • release • test-session$/);
	});

	it("leaves out the session ID of a session that is not saved", () => {
		const session = createSession({ sessionName: "release", persisted: false });
		const footer = new FooterComponent(session, createFooterData([]));

		expect(stripAnsi(footer.render(200)[0]!).trimEnd()).toMatch(/ \(main\) • release$/);
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(["模".repeat(30)]));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows the physical model a virtual model routed to", () => {
		const session = createSession({
			sessionName: "",
			modelId: "auto",
			reasoning: true,
			thinkingLevel: "high",
			routedModel: { model: { id: "gpt-5.6-luna" }, thinkingLevel: "medium" },
		});
		const footer = new FooterComponent(session, createFooterData([]));

		const statsLine = stripAnsi(footer.render(120)[1]);

		expect(statsLine).toContain("auto \u2022 high \u2192 gpt-5.6-luna \u2022 medium");
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData([]));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("$1.250");
	});

	it("updates cached usage totals after an entry is appended", () => {
		const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } };
		const session = createSession({ sessionName: "", usage });
		const footer = new FooterComponent(session, createFooterData([]));
		expect(stripAnsi(footer.render(120)[1])).toContain("$0.500");

		session.sessionManager.getEntries().push({ type: "message", message: { role: "assistant", usage } } as never);
		expect(stripAnsi(footer.render(120)[1])).toContain("$1.000");
	});

	it("shows the context size and leaves session token totals to /session", () => {
		const session = createSession({
			sessionName: "",
			contextTokens: 161_234,
			usage: { input: 520, output: 127_000, cacheRead: 28_000_000, cacheWrite: 477_000, cost: { total: 0 } },
			earlierRequests: 1,
		});
		const footer = new FooterComponent(session, createFooterData([]));

		expect(stripAnsi(footer.render(120)[1]).trimEnd()).toBe(`ctx 161k${" ".repeat(102)}test-model`);
	});

	it("puts extension statuses on the stats line when they fit next to the model", () => {
		const session = createSession({ sessionName: "", contextTokens: 12_000 });
		const footerData = createFooterData([], { timing: "● 0:12", "observational-memory": "compact 3%" });

		const wide = new FooterComponent(session, footerData).render(60).map((line) => stripAnsi(line).trimEnd());
		expect(wide).toEqual([
			"/tmp/project (main) • test-session",
			`ctx 12k · compact 3% · ● 0:12${" ".repeat(21)}test-model`,
		]);

		const narrow = new FooterComponent(session, footerData).render(30).map((line) => stripAnsi(line).trimEnd());
		expect(narrow.slice(1)).toEqual([`ctx 12k${" ".repeat(13)}test-model`, "compact 3% · ● 0:12"]);
	});

	it("names the provider only when another provider offers a model with the same id", () => {
		const session = createSession({ sessionName: "", provider: "pi-sub-anthropic", modelId: "claude-opus" });
		const stats = (sharedModelIds: readonly string[]) =>
			stripAnsi(new FooterComponent(session, createFooterData(sharedModelIds)).render(120)[1]).trimEnd();

		expect(stats([])).toMatch(/ claude-opus$/);
		expect(stats(["other-model"])).not.toContain("pi-sub-anthropic");
		expect(stats(["claude-opus"])).toMatch(/ \(pi-sub-anthropic\) claude-opus$/);
	});

	it("marks the context size when auto-compaction is off", () => {
		const footer = new FooterComponent(
			createSession({ sessionName: "", contextTokens: 9_500 }),
			createFooterData([]),
		);

		footer.setAutoCompactEnabled(false);

		expect(stripAnsi(footer.render(120)[1])).toMatch(/^ctx 9\.5k \(auto off\) /);
	});

	it("shows the cache hit rate only when a later request misses the cache", () => {
		const missed = { input: 100, output: 10, cacheRead: 50, cacheWrite: 50, cost: { total: 0 } };
		const hit = { input: 5, output: 10, cacheRead: 950, cacheWrite: 45, cost: { total: 0 } };
		const stats = (usage: AssistantUsage, earlierRequests: number) =>
			stripAnsi(
				new FooterComponent(
					createSession({ sessionName: "", contextTokens: 200, usage, earlierRequests }),
					createFooterData([]),
				).render(120)[1],
			);

		expect(stats(missed, 1)).toMatch(/^ctx 200 · cache 25% /);
		expect(stats(missed, 0)).toMatch(/^ctx 200 /);
		expect(stats(missed, 0)).not.toContain("cache");
		expect(stats(hit, 1)).not.toContain("cache");
	});

	it("leaves the estimated cost of a subscription out of the footer", () => {
		const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 1.234 } };
		const kimi = createSession({ sessionName: "", provider: "kimi-coding", usage });
		const subscription = createSession({ sessionName: "", provider: "anthropic", usingSubscription: true, usage });
		const apiKey = createSession({ sessionName: "", provider: "anthropic", usage });

		expect(stripAnsi(new FooterComponent(kimi, createFooterData([])).render(120)[1])).not.toContain("$");
		expect(stripAnsi(new FooterComponent(subscription, createFooterData([])).render(120)[1])).not.toContain("$");
		expect(stripAnsi(new FooterComponent(apiKey, createFooterData([])).render(120)[1])).toMatch(
			/^ctx \? · \$1\.234 /,
		);
	});

	it("does not mark generic OAuth sign-in as a subscription", () => {
		const session = createSession({
			sessionName: "",
			provider: "openrouter",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData([]));
		const stats = stripAnsi(footer.render(120)[1]);

		expect(stats).toContain("$1.234");
		expect(stats).not.toContain("(sub)");
	});
});
