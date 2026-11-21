import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLAPSE_BLOCK_TYPES,
  customMessageBlockType,
  DEFAULT_COLLAPSE_POLICY,
  parseCollapsePolicy,
  resolveBlockExpanded,
  toolCallBlockType,
} from "./collapse-policy.ts";

test("subagent results start collapsed; every other type starts as it did before the policy", () => {
  assert.deepEqual(DEFAULT_COLLAPSE_POLICY, {
    toolCalls: "collapsed",
    subagents: "collapsed",
    extensionMessages: "expanded",
    thinking: "collapsed",
    bash: "collapsed",
  });
  assert.deepEqual(Object.keys(DEFAULT_COLLAPSE_POLICY), [...COLLAPSE_BLOCK_TYPES]);
});

test("the Agent and get_subagent_result cards are subagent results, other tools tool calls", () => {
  assert.equal(toolCallBlockType("Agent"), "subagents");
  assert.equal(toolCallBlockType("get_subagent_result"), "subagents");
  for (const name of ["bash", "read", "steer_subagent", "agent", "mcp__agent__run"]) {
    assert.equal(toolCallBlockType(name), "toolCalls", name);
  }
});

test("a background subagent's report is a subagent result, any other shown custom message an extension message", () => {
  assert.equal(customMessageBlockType({ customType: "pi-web:subagent-notification", display: true }), "subagents");
  // @tintinweb/pi-subagents' completion, which turn grouping already treats as one.
  assert.equal(customMessageBlockType({ customType: "subagent-notification", display: true }), "subagents");
  assert.equal(customMessageBlockType({ customType: "pi-background-bash", display: true }), "extensionMessages");
});

test("a custom message kept for the model alone has no type and starts collapsed whatever the policy", () => {
  const allExpanded = Object.fromEntries(COLLAPSE_BLOCK_TYPES.map((type) => [type, "expanded"]));
  for (const display of [false, undefined]) {
    const type = customMessageBlockType({ customType: "pi-web:subagent-notification", display });
    assert.equal(type, null);
    assert.equal(resolveBlockExpanded(type, allExpanded, undefined), false);
  }
});

test("a block starts as its type's policy says until the user toggles it, and the toggle wins either way", () => {
  const policy = { ...DEFAULT_COLLAPSE_POLICY, toolCalls: "expanded" };
  assert.equal(resolveBlockExpanded("toolCalls", policy, undefined), true);
  assert.equal(resolveBlockExpanded("subagents", policy, undefined), false);
  assert.equal(resolveBlockExpanded("extensionMessages", policy, undefined), true);

  assert.equal(resolveBlockExpanded("toolCalls", policy, false), false);
  assert.equal(resolveBlockExpanded("subagents", policy, true), true);
  assert.equal(resolveBlockExpanded(null, policy, true), true);
});

test("a saved policy keeps the types it names correctly and defaults the rest", () => {
  assert.deepEqual(
    parseCollapsePolicy(JSON.stringify({ subagents: "expanded", thinking: "open", toolCalls: "expanded", unknown: "expanded" }), null),
    { ...DEFAULT_COLLAPSE_POLICY, subagents: "expanded", toolCalls: "expanded" },
  );
  for (const raw of ["", "not json", "null", "[]", "\"expanded\"", "42"]) {
    assert.deepEqual(parseCollapsePolicy(raw, null), DEFAULT_COLLAPSE_POLICY, raw);
  }
});

test("the older thinking switch decides thinking only while no policy is saved", () => {
  assert.equal(parseCollapsePolicy(null, "true").thinking, "expanded");
  assert.equal(parseCollapsePolicy(null, "false").thinking, "collapsed");
  assert.equal(parseCollapsePolicy(null, null).thinking, "collapsed");
  assert.equal(parseCollapsePolicy(JSON.stringify({ thinking: "collapsed" }), "true").thinking, "collapsed");
  assert.equal(parseCollapsePolicy("{}", "true").thinking, "collapsed");
});
