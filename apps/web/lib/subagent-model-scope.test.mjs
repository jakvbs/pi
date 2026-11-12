import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { agentModelDescription, isSubagentRoleModelReference, parseSubagentModel, scopedThinkingLevel, THINKING_LEVELS } = await createJiti(import.meta.url)
  .import("./subagent-model-scope.ts");

const opus = { provider: "pi-sub-anthropic", id: "claude-opus-5-5" };
const gpt = { provider: "pi-sub-openai", id: "gpt-5" };
const qwen = { provider: "ollama", id: "qwen3:8b" };
const scope = [{ model: opus }, { model: gpt, thinkingLevel: "high" }, { model: qwen }];
const ALLOWED = "Allowed: pi-sub-anthropic/claude-opus-5-5, pi-sub-openai/gpt-5:high, ollama/qwen3:8b.";

test("the model description lists exactly the scoped models, pinned levels included", () => {
  assert.match(agentModelDescription(scope), /one of: pi-sub-anthropic\/claude-opus-5-5, pi-sub-openai\/gpt-5:high, ollama\/qwen3:8b\. Any other model is refused\./);
  assert.doesNotMatch(agentModelDescription([]), /one of:|refused/);
});

test("a resolved model outside the scope is refused with who chose it and the allowed list", () => {
  const cases = [
    [{ model: { provider: "openai", id: "gpt-4o" }, source: "the call" }, "openai/gpt-4o from the call"],
    [{ model: { provider: "openai", id: "claude-opus-5-5" }, source: "role review" }, "openai/claude-opus-5-5 from role review"],
    // An id that ends in a level name is its own model, never the scoped `qwen3` at `8b` or `tuned` at `high`.
    [{ model: { provider: "ollama", id: "qwen3:8b:low" }, source: "profile scout-agent" }, "ollama/qwen3:8b:low from profile scout-agent"],
    [{ model: { provider: "pi-sub-openai", id: "gpt-5:high" }, source: "the parent" }, "pi-sub-openai/gpt-5:high from the parent"],
  ];
  for (const [choice, name] of cases) {
    assert.throws(() => scopedThinkingLevel(choice, scope), (error) =>
      error.message === `Subagent model ${name} is not allowed by enabledModels. ${ALLOWED}`, name);
  }
});

test("a scoped model without a pinned level takes any level and forces none", () => {
  for (const level of THINKING_LEVELS) {
    assert.equal(scopedThinkingLevel({ model: opus, level, source: "the call" }, scope), undefined);
  }
  assert.equal(scopedThinkingLevel({ model: qwen, source: "the parent" }, scope), undefined);
});

test("a model pinned to a level runs only at that level, whatever chose it", () => {
  assert.equal(scopedThinkingLevel({ model: gpt, level: "high", source: "the call" }, scope), "high");
  for (const source of ["the call", "role review", "profile scout-agent", "the parent"]) {
    assert.equal(scopedThinkingLevel({ model: gpt, source }, scope), "high", source);
  }
  assert.throws(() => scopedThinkingLevel({ model: gpt, level: "low", source: "role review" }, scope),
    (error) => error.message === `Subagent model pi-sub-openai/gpt-5:low from role review is not allowed by enabledModels. ${ALLOWED}`);
});

test("an empty scope admits any model", () => {
  assert.equal(scopedThinkingLevel({ model: { provider: "openai", id: "gpt-4o" }, level: "high", source: "the call" }, []), undefined);
});

test("a role's model passes the load check exactly when the run's own parse could resolve it", () => {
  // Each is resolved by parseSubagentModel against a catalog holding the model it names.
  for (const [reference, provider, id] of [
    ["pi-sub-anthropic/claude-opus-5-5:medium", "pi-sub-anthropic", "claude-opus-5-5"],
    ["google/gemini-4-carbon", "google", "gemini-4-carbon"],
    ["openrouter/anthropic/claude-sonnet-4:high", "openrouter", "anthropic/claude-sonnet-4"],
    ["ollama/qwen3:8b", "ollama", "qwen3:8b"],
    ["ollama/qwen3:8b:low", "ollama", "qwen3:8b"],
    ["claude-opus-5-5", "anthropic", "claude-opus-5-5"],
    ["claude-opus-5-5:high", "anthropic", "claude-opus-5-5"],
    ["pi-sub-anthropic/claude-opus-5-5:turbo", "pi-sub-anthropic", "claude-opus-5-5:turbo"],
  ]) {
    const model = { provider, id };
    const catalog = { getModel: (p, i) => (p === provider && i === id ? model : undefined), getModels: () => [model] };
    assert.equal(parseSubagentModel(catalog, reference).model, model, reference);
    assert.equal(isSubagentRoleModelReference(reference), true, reference);
  }
  // No catalog can match these: an empty provider or model id, or whitespace.
  for (const malformed of ["", "/claude-opus-5-5", "pi-sub-anthropic/", "pi-sub-anthropic/claude opus:high", "claude opus"]) {
    assert.equal(isSubagentRoleModelReference(malformed), false, malformed);
  }
});
