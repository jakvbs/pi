// The models `Agent` may start a subagent on: the parent session's scope, pi's `enabledModels`.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";

/** The thinking levels a `:level` suffix on a subagent model reference may name. */
export const THINKING_LEVELS: ReadonlySet<string> = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const LEVELS_TEXT = [...THINKING_LEVELS].join(", ");

const scopedModelName = ({ model, thinkingLevel }: ScopedModel): string =>
  `${model.provider}/${model.id}${thinkingLevel === undefined ? "" : `:${thinkingLevel}`}`;

/** The `model` parameter's description: the scoped models when the session has a scope. */
export function agentModelDescription(scope: readonly ScopedModel[]): string {
  if (scope.length === 0) {
    return `Optional provider/modelId override. Append ":<level>" (${LEVELS_TEXT}) to also set the thinking level for this run, e.g. "provider/model:high".`;
  }
  return `Optional model override, one of: ${scope.map(scopedModelName).join(", ")}. Any other model is refused. A model listed without a level takes ":<level>" (${LEVELS_TEXT}) to also set the thinking level for this run, e.g. "provider/model:high"; a listed level is the only one that model runs at.`;
}

/** Whether a reference names the model as `findSubagentModel` reads it: `provider/modelId`, or a bare id. */
function names(reference: string, { model }: ScopedModel): boolean {
  const slash = reference.indexOf("/");
  return slash > 0
    ? model.provider === reference.slice(0, slash) && model.id === reference.slice(slash + 1)
    : model.id === reference;
}

/**
 * The thinking level a call's model reference runs at under the scope: its `:level`, else the
 * scope's pinned level for that model. Throws a refusal listing the scope when the reference names
 * no scoped model, or a level other than the pinned one. An empty scope admits any model. As
 * `parseSubagentModel` reads a reference, the whole value is tried before a `:level` suffix.
 */
export function scopedThinkingLevel(value: string | undefined, scope: readonly ScopedModel[]): ThinkingLevel | undefined {
  const reference = value?.trim();
  if (!reference || scope.length === 0) return undefined;
  const whole = scope.find((entry) => names(reference, entry));
  if (whole) return whole.thinkingLevel;
  const colon = reference.lastIndexOf(":");
  const level = reference.slice(colon + 1) as ThinkingLevel;
  if (colon > 0 && THINKING_LEVELS.has(level)) {
    const base = scope.find((entry) => names(reference.slice(0, colon), entry));
    if (base && (base.thinkingLevel === undefined || base.thinkingLevel === level)) return level;
  }
  throw new Error(`Subagent model ${reference} is not allowed by enabledModels. Allowed: ${scope.map(scopedModelName).join(", ")}.`);
}
