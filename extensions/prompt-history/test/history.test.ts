import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import promptHistoryExtension, { aggregateHistory, fuzzyScore, isMeaningfulPrompt, mergeHistory, rankHistory, readSessionHistory, resolveShortcut } from "../src/index.ts";

test("isMeaningfulPrompt rejects numeric-only accidental submissions", () => {
	assert.equal(isMeaningfulPrompt("1"), false);
	assert.equal(isMeaningfulPrompt("  123  "), false);
	assert.equal(isMeaningfulPrompt("123 deploys"), true);
	assert.equal(isMeaningfulPrompt("检查 123"), true);
});

test("fuzzyScore accepts in-order subsequences and rejects out-of-order text", () => {
	assert.notEqual(fuzzyScore("please inspect the auth module", "pam"), undefined);
	assert.equal(fuzzyScore("please inspect the auth module", "map"), undefined);
});

test("fuzzyScore prefers consecutive matches", () => {
	const consecutive = fuzzyScore("zz ng foo", "ng")!;
	const split = fuzzyScore("zz n foo g", "ng")!;
	assert.ok(consecutive > split);
});

test("resolveShortcut uses the environment override and falls back for empty values", () => {
	assert.equal(resolveShortcut({ shortcut: "alt+r" }, "ctrl+shift+r"), "ctrl+shift+r");
	assert.equal(resolveShortcut({ shortcut: "alt+r" }), "alt+r");
	assert.equal(resolveShortcut({ shortcut: "" }), "ctrl+r");
});

test("rankHistory prioritizes score and then newest matching prompt", () => {
	const ranked = rankHistory([
		{ text: "inspect API errors", recency: 1 },
		{ text: "inspect application logs", recency: 2 },
		{ text: "deploy application", recency: 3 },
	], "app");
	assert.deepEqual(ranked.map((item) => item.text), [
		"deploy application",
		"inspect application logs",
	]);
});

test("mergeHistory retains one copy of a prompt at its newest use", () => {
	const merged = mergeHistory(
		[{ text: "commit + push", recency: 10 }, { text: "older", recency: 5 }],
		[{ text: "commit + push", recency: 20 }, { text: "newer", recency: 15 }],
	);
	assert.deepEqual(rankHistory(merged, "").map((item) => item.text), [
		"commit + push",
		"newer",
		"older",
	]);
});

test("rankHistory lists an empty-query history in reverse chronological order", () => {
	const ranked = rankHistory([
		{ text: "oldest prompt", recency: 4 },
		{ text: "middle prompt", recency: 12 },
		{ text: "newest prompt", recency: 20 },
	], "");
	assert.deepEqual(ranked.map((item) => item.text), [
		"newest prompt",
		"middle prompt",
		"oldest prompt",
	]);
});

test("workspace history includes saved sessions for this cwd, not other workspaces", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-prompt-history-"));
	try {
		for (const [cwd, prompt] of [[join(dir, "one"), "first workspace"], [join(dir, "one"), "second session"], [join(dir, "two"), "other workspace"]]) {
			const session = SessionManager.create(cwd, dir);
			session.appendMessage({ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() });
			// Pi persists a session only after its first assistant response.
			session.appendMessage({
				role: "assistant", content: [], api: "openai-completions", provider: "openai", model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: Date.now(),
			});
		}
		const history = await readSessionHistory(join(dir, "one"), dir);
		assert.deepEqual(new Set(history.map((item) => item.text)), new Set(["first workspace", "second session"]));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("global history ranks repeated prompts by frequency and then recency", () => {
	const globalHistory = aggregateHistory(
		[{ text: "old frequent", recency: 5 }, { text: "new infrequent", recency: 20 }],
		[{ text: "old frequent", recency: 10 }],
	);
	assert.deepEqual(rankHistory(globalHistory, "").map((item) => item.text), [
		"old frequent",
		"new infrequent",
	]);
	assert.equal(globalHistory.find((item) => item.text === "old frequent")?.frequency, 2);
});

test("history picker uses inline layout so transcript images cannot cover it", async () => {
	const handlers: Array<(ctx: ExtensionCommandContext) => Promise<void>> = [];
	const pi: Pick<ExtensionAPI, "on" | "registerShortcut" | "registerCommand"> = {
		on() { return () => {}; },
		registerShortcut(_key, options) {
			handlers.push(async (ctx) => { await options.handler(ctx); });
		},
		registerCommand(_name, options) {
			handlers.push(async (ctx) => { await options.handler("", ctx); });
		},
	};
	promptHistoryExtension(pi as ExtensionAPI);
	assert.equal(handlers.length, 2);

	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({ role: "user", content: "inspect screenshot", timestamp: 1 });
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	type CustomFactory = Parameters<ExtensionContext["ui"]["custom"]>[0];
	for (const handler of handlers) {
		for (const key of ["\r", "\x1b"]) {
			let editorText = "unfinished draft";
			let renders = 0;
			const ctx = {
				sessionManager,
				ui: {
					async custom(factory: CustomFactory, options?: Parameters<ExtensionContext["ui"]["custom"]>[1]) {
						assert.notEqual(options?.overlay, true);
						let result: unknown;
						const component = await factory(
							{ requestRender: () => { renders++; } } as TUI,
							theme, {} as Parameters<CustomFactory>[2], (value) => { result = value; },
						);
						if ("focused" in component) component.focused = true;
						// An image occupies eight transcript rows, independently of the picker.
						const imageLines = ["\x1b_Ga=T,r=8;image\x1b\\", ...Array<string>(7).fill("")];
						const layout = new Container();
						layout.addChild({ render: () => imageLines, invalidate() {} });
						layout.addChild(component);
						for (const width of [40, 120]) {
							const lines = layout.render(width);
							assert.deepEqual(lines.slice(0, 8), imageLines);
							assert.match(lines[9], /Prompt history/);
							assert.ok(lines.slice(8).some((line) => line.includes(CURSOR_MARKER)));
							assert.ok(lines.slice(8).some((line) => line.includes("esc cancel")));
							assert.ok(lines.slice(8).every((line) => visibleWidth(line) <= width));
						}
						component.handleInput?.(key);
						assert.equal(result, key === "\r" ? "inspect screenshot" : null);
						return result;
					},
					setEditorText(text: string) { editorText = text; },
				},
			} as unknown as ExtensionCommandContext;
			await handler(ctx);
			assert.equal(editorText, key === "\r" ? "inspect screenshot" : "unfinished draft");
			assert.ok(renders > 0);
		}
	}
});
