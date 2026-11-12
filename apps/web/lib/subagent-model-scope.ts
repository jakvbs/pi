// The models `Agent` may start a subagent on: the parent session's scope, pi's `enabledModels`.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";

/** The thinking levels a `:level` suffix on a subagent model reference may name. */
export const THINKING_LEVELS: ReadonlySet<string> = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const LEVELS_TEXT = [...THINKING_LEVELS].join(", ");

const scopedModelName = ({ model, thinkingLevel }: ScopedModel): string =>
  `${model.provider}/${model.id}${thinkingLevel === undefined ? "" : `:${thinkingLevel}`}`;

/** The scope as a refusal names it: `Allowed: a, b:high.` */
export const allowedModelsText = (scope: readonly ScopedModel[]): string => `Allowed: ${scope.map(scopedModelName).join(", ")}.`;

/** The `model` parameter's description: the scoped models when the session has a scope. */
export function agentModelDescription(scope: readonly ScopedModel[]): string {
  if (scope.length === 0) {
    return `Optional provider/modelId override. Append ":<level>" (${LEVELS_TEXT}) to also set the thinking level for this run, e.g. "provider/model:high".`;
  }
  return `Optional model override, one of: ${scope.map(scopedModelName).join(", ")}. Any other model is refused. A model listed without a level takes ":<level>" (${LEVELS_TEXT}) to also set the thinking level for this run, e.g. "provider/model:high"; a listed level is the only one that model runs at.`;
}

/** The model a child would run and who chose it: the call, a role, the profile or the parent. */
export interface SubagentModelChoice {
  model: { provider: string; id: string };
  /** The level the call or the role wrote with the model; a pinned model must match it. */
  level?: ThinkingLevel;
  /** Who chose the model, named in a refusal: "the call", "role review", "profile scout-agent", "the parent". */
  source: string;
}

/**
 * The level a pinned scoped model forces on the child, decided on the model the reference resolved
 * to (so a model whose id ends in `:high` is never read as another model at `high`). Throws a
 * refusal listing the scope when the model is outside it, or the call or role wrote a level other
 * than its pin. An empty scope admits any model.
 */
export function scopedThinkingLevel({ model, level, source }: SubagentModelChoice, scope: readonly ScopedModel[]): ThinkingLevel | undefined {
  if (scope.length === 0) return undefined;
  const entry = scope.find((scoped) => scoped.model.provider === model.provider && scoped.model.id === model.id);
  if (entry && (entry.thinkingLevel === undefined || level === undefined || level === entry.thinkingLevel)) return entry.thinkingLevel;
  const name = `${model.provider}/${model.id}${level === undefined ? "" : `:${level}`}`;
  throw new Error(`Subagent model ${name} from ${source} is not allowed by enabledModels. ${allowedModelsText(scope)}`);
}
