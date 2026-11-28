import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatActiveDuration, formatCompactCount, formatCostShort, formatSessionSummary } = await jiti.import("./session-stats-format.ts");
const { translateMessage } = await jiti.import("./i18n/format.ts");
const { getLocalePlugin } = await jiti.import("./i18n/registry.ts");
const messages = { en: getLocalePlugin("en").messages };
const t = (key, params) => translateMessage("en", key, messages, params);

test("a tab's /session says what the popover's first lines say", () => {
  assert.equal(formatSessionSummary({ totalMessages: 4, tokens: { total: 18_400 }, cost: 0.12 }, t), "4 messages · 18k tokens · $0.12");
  assert.equal(formatSessionSummary({ totalMessages: 2, tokens: { total: 950 }, cost: 0 }, t), "2 messages · 950 tokens");
  assert.equal(formatSessionSummary(null, t), "No usage yet");
});

test("a tab's /session rounds a small cost up and counts one message", () => {
  const stats = { totalMessages: 4, tokens: { total: 18_400 }, cost: 0.004 };
  assert.equal(formatSessionSummary(stats, t), "4 messages · 18k tokens · <$0.01");
  assert.equal(formatSessionSummary({ ...stats, totalMessages: 1, cost: 0 }, t), "1 message · 18k tokens");
});

test("formats counts, costs and durations as the stats toolbar shows them", () => {
  assert.equal(formatCompactCount(950), "950");
  assert.equal(formatCompactCount(18_400), "18k");
  assert.equal(formatCompactCount(1_240_000), "1.2M");
  // Just under a million rounds up to the next unit instead of reading 1000k.
  assert.equal(formatCompactCount(999_499), "999k");
  assert.equal(formatCompactCount(999_500), "1.0M");
  assert.equal(formatCompactCount(999_999), "1.0M");
  assert.equal(formatCostShort(0), null);
  assert.equal(formatCostShort(0.004), "<$0.01");
  assert.equal(formatCostShort(0.456), "$0.46");
  assert.equal(formatActiveDuration(0), "0s");
  assert.equal(formatActiveDuration(42_000), "42s");
  assert.equal(formatActiveDuration(185_000), "3m 5s");
  assert.equal(formatActiveDuration(4_800_000), "1h 20m");
});
