// The models `Agent` may start a subagent on: the parent session's scope, pi's `enabledModels`.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";

const THINKING_LEVEL_LIST: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The thinking levels a `:level` suffix on a subagent model reference, or `Agent`'s `thinking`, may name. */
export const THINKING_LEVELS: ReadonlySet<string> = new Set(THINKING_LEVEL_LIST);

/** The thinking level `value` names, if it names one. */
export function parseThinkingLevel(value: string): ThinkingLevel | undefined {
  return THINKING_LEVEL_LIST.find((level) => level === value);
}

/** The levels as a message lists them: `off, minimal, …, max`. */
export const LEVELS_TEXT = THINKING_LEVEL_LIST.join(", ");

/** The models a reference is looked up among: pi's `ModelRuntime`, or a session's registry adapted to it. */
export interface ModelLookup<M extends { provider: string; id: string }> {
  getModel(provider: string, modelId: string): M | undefined;
  getModels(): readonly M[];
}

function findSubagentModel<M extends { provider: string; id: string }>(models: ModelLookup<M>, reference: string): M | undefined {
  const slash = reference.indexOf("/");
  if (slash > 0) return models.getModel(reference.slice(0, slash), reference.slice(slash + 1));
  const matches = models.getModels().filter((model) => model.id === reference);
  if (matches.length > 1) throw new Error(`Subagent model is ambiguous; use provider/modelId: ${reference}`);
  return matches[0];
}

/** A reference's `:level` suffix, read from the text alone: the reference without it and the level. */
function splitLevel(reference: string): { base: string; level: ThinkingLevel } | undefined {
  const colon = reference.lastIndexOf(":");
  const level = colon > 0 ? parseThinkingLevel(reference.slice(colon + 1)) : undefined;
  return level ? { base: reference.slice(0, colon), level } : undefined;
}

/** The level a model reference ends in, read from its text; for a role's level when the call replaced its model. */
export function modelReferenceLevel(reference: string): ThinkingLevel | undefined {
  return splitLevel(reference.trim())?.level;
}

/**
 * The ways `parseSubagentModel` reads a reference, in the order it tries them: the whole reference,
 * then the reference without a `:level` suffix.
 */
function modelReferenceReadings(reference: string): { base: string; level?: ThinkingLevel }[] {
  const split = splitLevel(reference);
  return split ? [{ base: reference }, split] : [{ base: reference }];
}

/** Whether a lookup could ever find `base`: a bare id, or `provider/modelId` with both parts. */
function isModelKey(base: string): boolean {
  const slash = base.indexOf("/");
  return base !== "" && !/\s/.test(base) && slash !== 0 && slash !== base.length - 1;
}

/**
 * Whether a role's `model` in `roles.json` could resolve at all, read as `parseSubagentModel` reads
 * it (so `ollama/qwen3:8b` and a bare id pass); checked when the file loads, where no models are
 * known yet, so an entry no lookup can match is reported before a call uses it.
 */
export function isSubagentRoleModelReference(reference: string): boolean {
  return modelReferenceReadings(reference).some(({ base }) => isModelKey(base));
}

/**
 * Reads a model reference as pi's `--model` does: `provider/modelId` or a bare id, optionally
 * followed by `:<thinking level>`. The whole reference is tried first, so an id that itself
 * contains a colon (`qwen3:8b`) still matches; a suffix that is no thinking level never matches.
 */
export function parseSubagentModel<M extends { provider: string; id: string }>(
  models: ModelLookup<M>,
  value: string | undefined,
): { model: M; thinkingLevel?: ThinkingLevel } | undefined {
  if (!value?.trim()) return undefined;
  const requested = value.trim();
  for (const { base, level } of modelReferenceReadings(requested)) {
    const model = findSubagentModel(models, base);
    if (model) return level ? { model, thinkingLevel: level } : { model };
  }
  throw new Error(`Subagent model not found: ${requested}`);
}

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

/**
 * Whether a role's model reference starts a child under the scope, for the declaration: resolved as
 * `parseSubagentModel` resolves it, then judged as `scopedThinkingLevel` judges it.
 */
export function referenceInScope<M extends { provider: string; id: string }>(
  reference: string,
  models: ModelLookup<M>,
  scope: readonly ScopedModel[],
): boolean {
  if (scope.length === 0) return true;
  try {
    const parsed = parseSubagentModel(models, reference);
    if (!parsed) return false;
    scopedThinkingLevel({ model: parsed.model, level: parsed.thinkingLevel, source: "the role" }, scope);
    return true;
  } catch {
    return false;
  }
}
