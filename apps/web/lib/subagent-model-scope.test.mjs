import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { agentModelDescription, scopedThinkingLevel, THINKING_LEVELS } = await createJiti(import.meta.url)
  .import("./subagent-model-scope.ts");

const scope = [
  { model: { provider: "pi-sub-anthropic", id: "claude-opus-5-5" } },
  { model: { provider: "pi-sub-openai", id: "gpt-5" }, thinkingLevel: "high" },
  { model: { provider: "ollama", id: "qwen3:8b" } },
];
const ALLOWED = "Allowed: pi-sub-anthropic/claude-opus-5-5, pi-sub-openai/gpt-5:high, ollama/qwen3:8b.";

test("the model description lists exactly the scoped models, pinned levels included", () => {
  assert.match(agentModelDescription(scope), /one of: pi-sub-anthropic\/claude-opus-5-5, pi-sub-openai\/gpt-5:high, ollama\/qwen3:8b\. Any other model is refused\./);
  assert.doesNotMatch(agentModelDescription([]), /one of:|refused/);
});

test("a model outside the scope is refused with the allowed list", () => {
  for (const reference of ["openai/gpt-4o", "gpt-4o", "openai/claude-opus-5-5", "pi-sub-anthropic/claude-opus-5-5:bogus"]) {
    assert.throws(() => scopedThinkingLevel(reference, scope), (error) =>
      error.message === `Subagent model ${reference} is not allowed by enabledModels. ${ALLOWED}`, reference);
  }
});

test("a scoped model without a pinned level takes any level", () => {
  for (const level of THINKING_LEVELS) {
    assert.equal(scopedThinkingLevel(`pi-sub-anthropic/claude-opus-5-5:${level}`, scope), level);
  }
  assert.equal(scopedThinkingLevel(" claude-opus-5-5 ", scope), undefined);
  assert.equal(scopedThinkingLevel("ollama/qwen3:8b", scope), undefined);
  assert.equal(scopedThinkingLevel("ollama/qwen3:8b:low", scope), "low");
});

test("a model pinned to a level runs only at that level", () => {
  assert.equal(scopedThinkingLevel("pi-sub-openai/gpt-5:high", scope), "high");
  assert.equal(scopedThinkingLevel("pi-sub-openai/gpt-5", scope), "high");
  assert.throws(() => scopedThinkingLevel("pi-sub-openai/gpt-5:low", scope), new RegExp(ALLOWED.replaceAll(".", "\\.")));
});

test("no model, or no scope, leaves the choice to the profile and the parent", () => {
  assert.equal(scopedThinkingLevel(undefined, scope), undefined);
  assert.equal(scopedThinkingLevel("  ", scope), undefined);
  assert.equal(scopedThinkingLevel("openai/gpt-4o", []), undefined);
  assert.equal(scopedThinkingLevel("openai/gpt-4o:high", []), undefined);
});
