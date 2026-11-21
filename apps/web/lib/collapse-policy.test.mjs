import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLAPSE_BLOCK_TYPES,
  customMessageBlockType,
  DEFAULT_COLLAPSE_POLICY,
  toolCallBlockType,
} from "./collapse-policy.ts";

test("subagent results start collapsed; every other type starts as it did before the policy", () => {
  assert.deepEqual(DEFAULT_COLLAPSE_POLICY, {
    toolCalls: "collapsed",
    subagents: "collapsed",
    extensionMessages: "expanded",
    thinking: "collapsed",
  });
  assert.deepEqual(Object.keys(DEFAULT_COLLAPSE_POLICY), [...COLLAPSE_BLOCK_TYPES]);
});

test("the Agent and get_subagent_result cards are subagent results, other tools and ! commands tool calls", () => {
  assert.equal(toolCallBlockType("Agent"), "subagents");
  assert.equal(toolCallBlockType("get_subagent_result"), "subagents");
  for (const name of ["bash", "bash (local)", "read", "steer_subagent", "agent", "mcp__agent__run"]) {
    assert.equal(toolCallBlockType(name), "toolCalls", name);
  }
});

test("a background subagent's report is a subagent result, any other custom message an extension message", () => {
  assert.equal(customMessageBlockType("pi-web:subagent-notification"), "subagents");
  // @tintinweb/pi-subagents' completion, which turn grouping already treats as one.
  assert.equal(customMessageBlockType("subagent-notification"), "subagents");
  assert.equal(customMessageBlockType("pi-background-bash"), "extensionMessages");
});
