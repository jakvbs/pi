import assert from "node:assert/strict";
import { test } from "node:test";
import { findText } from "./find.ts";

test("case-insensitive matches come back with surrounding context and per-query counts", () => {
	const text = `${"a".repeat(1000)} The Rate Limit is 60 requests. ${"b".repeat(1000)}`;
	const found = findText(text, ["rate limit"], "case-insensitive");
	assert.equal(found.matchCount, 1);
	assert.equal(found.returnedMatches, 1);
	assert.match(found.text, /^Text matches \(case-insensitive\)/);
	assert.match(found.text, /1\. "rate limit" ×1\n…a+ The Rate Limit is 60 requests\. b+…/);
});

test("exact mode respects case and missing queries are named", () => {
	const found = findText("Alpha beta", ["alpha", "beta"], "exact");
	assert.equal(found.matchCount, 1);
	assert.match(found.text, /"beta" ×1/);
	assert.match(found.text, /No matches: "alpha"/);
	assert.equal(findText("Alpha", ["zzz"], "exact").text, 'Text matches (exact): no matches\n\nNo matches: "zzz"');
});

test("nearby matches merge into one excerpt", () => {
	const found = findText("foo bar foo bar", ["foo", "bar"], "case-insensitive");
	assert.equal(found.matchCount, 4);
	assert.match(found.text, /1\. "foo" ×2, "bar" ×2\nfoo bar foo bar$/);
	assert.doesNotMatch(found.text, /\n2\. /);
});

test("output stays bounded and says how many matches it shows", () => {
	const text = Array.from({ length: 200 }, (_, index) => `needle ${index} ${"x".repeat(900)}`).join("\n");
	const found = findText(text, ["needle"], "case-insensitive");
	assert.equal(found.matchCount, 200);
	assert.ok(found.text.length <= 20_000, String(found.text.length));
	assert.ok(found.returnedMatches < 200);
	assert.match(found.text, new RegExp(`Showing ${found.returnedMatches} of 200 matches\\.$`));
});
