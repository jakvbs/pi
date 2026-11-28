import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRelativeTime,
  formatShortRelativeTime,
  formatUpdatedTime,
  interpolateMessage,
  translateMessage,
} from "./format.ts";

test("interpolates string and numeric parameters", () => {
  assert.equal(interpolateMessage("Hello, {name} ({count})", { name: "Pi", count: 2 }), "Hello, Pi (2)");
});

test("returns the key when the message is missing", () => {
  assert.equal(translateMessage("en", "common.ok", { en: { "common.ok": "OK" } }), "OK");
  assert.equal(translateMessage("en", "missing.key", { en: {} }), "missing.key");
});

test("formats relative time", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(formatRelativeTime(new Date("2026-01-01T00:05:00.000Z"), "en", now), "in 5 minutes");
  assert.equal(formatRelativeTime(new Date("2025-12-31T23:00:00.000Z"), "en", now), "1 hour ago");
});

test("shows a clock time today and a relative day for earlier updates", () => {
  const now = new Date(2026, 8, 22, 21, 18, 0);
  const today = new Date(2026, 8, 22, 9, 5, 0);
  const earlier = new Date(2026, 8, 19, 21, 18, 0);
  assert.equal(
    formatUpdatedTime(today.getTime(), "en", now),
    today.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
  );
  assert.equal(formatUpdatedTime(earlier.getTime(), "en", now), "3 days ago");
});

test("formats compact sidebar times", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  const ago = (ms) => new Date(now.getTime() - ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const cases = [
    [ago(59_999), "now"],
    [ago(minute), "1m"],
    [ago(59 * minute), "59m"],
    [ago(hour), "1h"],
    [ago(23 * hour + 59 * minute), "23h"],
    [ago(day), "1d"],
    [ago(6 * day), "6d"],
    [ago(7 * day), "1w"],
    [ago(29 * day), "4w"],
    [ago(30 * day), "1mo"],
    [ago(364 * day), "12mo"],
    [ago(365 * day), "1y"],
    [ago(800 * day), "2y"],
  ];
  for (const [date, en] of cases) {
    assert.equal(formatShortRelativeTime(date, "en", now), en);
  }
});

test("compact sidebar times accept ISO strings and tolerate odd input", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  assert.equal(formatShortRelativeTime("2026-10-07T09:30:00.000Z", "en", now), "2h");
  assert.equal(formatShortRelativeTime("2026-10-08T12:00:00.000Z", "en", now), "now", "future dates count as now");
  assert.equal(formatShortRelativeTime("not a date", "en", now), "");
  assert.equal(formatShortRelativeTime(new Date(Number.NaN), "en", now), "");
  assert.equal(formatShortRelativeTime("2026-10-07T11:55:00.000Z", "fr", now), "5m", "unknown locales use English");
});
