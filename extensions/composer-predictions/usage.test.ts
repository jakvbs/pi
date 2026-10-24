import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendUsage, describeUsage, readUsage, type Usage } from "./usage.ts";

const typed: Usage = {
	at: Date.UTC(2026, 9, 24, 10),
	threshold: 0.3,
	chars: 40,
	words: 8,
	offered: 5,
	accepted: 2,
	insertedChars: 12,
};
const later: Usage = {
	...typed,
	at: Date.UTC(2026, 9, 25, 9),
	chars: 60,
	words: 12,
	offered: 3,
	accepted: 1,
	insertedChars: 8,
};
const lowThreshold: Usage = {
	at: Date.UTC(2026, 9, 23, 8),
	threshold: 0.15,
	chars: 20,
	words: 4,
	offered: 4,
	accepted: 0,
	insertedChars: 0,
};

test("usage per threshold counts inserted characters less one key per taken ghost", () => {
	assert.equal(
		describeUsage([typed, lowThreshold, later]),
		"Since 2026-10-23: threshold 0.15: 1 message, 0.0% of keystrokes saved, 0 of 4 ghosts taken, 100 not taken per 100 words; threshold 0.3: 2 messages, 17.0% of keystrokes saved, 3 of 8 ghosts taken, 25 not taken per 100 words.",
	);
	assert.equal(describeUsage([]), "No messages logged yet.");
});

test("the log is read back without a line cut short or of another shape, and is empty before the first message", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "composer-usage-")), "composer-predictions", "usage.jsonl");
	assert.deepEqual(await readUsage(file), []);
	await appendUsage(file, typed);
	appendFileSync(file, '{"at":1,"threshold":0.3}\n{"at":2,"thresh');
	appendFileSync(file, "\n");
	await appendUsage(file, later);
	assert.deepEqual(await readUsage(file), [typed, later]);
});
