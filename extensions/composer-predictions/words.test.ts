import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { loadPrompts } from "./history.ts";
import { replay } from "./replay.ts";
import { suggest, WordModel } from "./words.ts";

function trained(...prompts: string[]): WordModel {
	const model = new WordModel();
	for (const prompt of prompts) model.learn(prompt);
	return model;
}

function assertGhost(actual: ReturnType<typeof suggest>, start: number, rest: string, confidence: number): void {
	assert.ok(actual, `expected ghost ${rest}`);
	assert.equal(actual.start, start);
	assert.equal(actual.rest, rest);
	assert.ok(
		Math.abs(actual.confidence - confidence) < 1e-12,
		`confidence ${actual.confidence}, expected ${confidence}`,
	);
}

const model = trained("run the tests", "run the tests", "run the linter");

test("ghost completes the typed word from what followed the two words before it", () => {
	assertGhost(suggest(model, "run the t"), 8, "ests", 23 / 26);
	assertGhost(suggest(model, "run the TE"), 8, "STS", 1);
});

test("ghost offers the next word after a space and the first word in an empty draft", () => {
	assertGhost(suggest(model, "run the "), 8, "tests", 46 / 81);
	assert.equal(suggest(model, "")?.rest, "run");
	assert.equal(suggest(model, "run ")?.rest, "the");
});

test("no ghost after punctuation, for an unknown prefix, or when the typed word is already the likeliest", () => {
	assert.equal(suggest(model, "run the,"), undefined);
	assert.equal(suggest(model, "run the x"), undefined);
	assert.equal(suggest(model, "run the"), undefined);
});

test("a word becomes a ghost from its second use, also when learned after the first completion", () => {
	const growing = trained("run the tests");
	assert.equal(suggest(growing, "dep"), undefined);
	growing.learn("deploy now");
	assert.equal(suggest(growing, "dep"), undefined);
	growing.learn("deploy now");
	assert.equal(suggest(growing, "dep")?.rest, "loy");
});

test("a word holding a run of 12 letters or digits with a digit never shows, yet counts against the others", () => {
	const tokens = trained(
		...Array<string>(3).fill("resume 019a3f2e-7c1d-4b8a-9e2f-5d6c7b8a9f0e with sonnet-4-5"),
		"deploy",
		"deploy",
		"dep1a2b3c4d5e6f",
		"dep1a2b3c4d5e6f",
	);
	assert.equal(suggest(tokens, "resume 0"), undefined);
	assert.equal(suggest(tokens, "with so")?.rest, "nnet-4-5");
	assertGhost(suggest(tokens, "dep"), 0, "loy", 1 / 2);
});

test("a UUID never shows, also when no 12-character group of it holds a digit", () => {
	const ids = trained(...Array<string>(3).fill("open 12345678-1234-4abc-8abc-abcdefabcdef now"));
	assert.equal(suggest(ids, "open 12345678-1234-4"), undefined);
	assert.equal(suggest(ids, "open 1234")?.rest, undefined);
	assert.equal(suggest(ids, "open 12345678-1234-4abc-8abc-abcdefabcdef n")?.rest, "ow");
});

test("replay types out the newest prompt with a model of the ones before it", () => {
	const result = replay(["run the tests", "run the tests", "run the tests"], 1);
	assert.deepEqual(
		{ ...result, msPerQuery: undefined },
		{
			typedOut: 1,
			retypes: 0,
			keys: 13,
			words: 3,
			byThreshold: [
				{ threshold: 0.15, saved: 10, wrongWords: 0 },
				{ threshold: 0.3, saved: 10, wrongWords: 0 },
				{ threshold: 0.45, saved: 10, wrongWords: 0 },
			],
			msPerQuery: undefined,
		},
	);
	assert.equal(replay(["run the tests", "run the testz"], 1).retypes, 1);
});

function historyHome(): { home: string; agentDir: string } {
	const home = mkdtempSync(join(tmpdir(), "composer-history-"));
	const agentDir = join(home, ".pi/agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(home, ".claude"));
	mkdirSync(join(home, ".codex"));
	mkdirSync(join(home, ".omp/agent"), { recursive: true });
	writeFileSync(
		join(home, ".claude/history.jsonl"),
		`${JSON.stringify({ display: "[Image #1] from claude", timestamp: 1000 })}\nnull\n{"display": "cut mid-wr\n`,
	);
	writeFileSync(join(home, ".codex/history.jsonl"), `${JSON.stringify({ text: "x".repeat(2001), ts: 2 })}\n`);
	return { home, agentDir };
}

test("history merges pi, Claude Code, Codex and oh-my-pi prompts oldest first", async () => {
	const { home, agentDir } = historyHome();
	writeFileSync(
		join(agentDir, "pi-prompt-history-history.json"),
		JSON.stringify({ prompts: [{ text: "from pi", lastUsedAt: 4000 }, { text: "no time" }] }),
	);
	const db = new DatabaseSync(join(home, ".omp/agent/history.db"));
	db.exec("create table history (prompt text, created_at integer)");
	db.prepare("insert into history values (?, ?)").run("from omp", 3);
	db.close();

	assert.deepEqual(await loadPrompts(agentDir, { home }), {
		prompts: [
			{ text: "  from claude", at: 1000, source: "claude" },
			{ text: "from omp", at: 3000, source: "omp" },
			{ text: "from pi", at: 4000, source: "pi" },
		],
		failures: [],
	});
});

test("a history that cannot be read is reported and the other sources still load", async () => {
	const { home, agentDir } = historyHome();
	writeFileSync(join(agentDir, "pi-prompt-history-history.json"), JSON.stringify({ version: 2 }));
	new DatabaseSync(join(home, ".omp/agent/history.db")).close();

	assert.deepEqual(await loadPrompts(agentDir, { home }), {
		prompts: [{ text: "  from claude", at: 1000, source: "claude" }],
		failures: [
			{ source: "pi", reason: "no prompts array" },
			{ source: "omp", reason: "no such table: history" },
		],
	});
});
