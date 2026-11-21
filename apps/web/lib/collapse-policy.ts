/**
 * Which transcript blocks start expanded: one choice per block type, kept per
 * browser (hooks/useCollapsePolicy.ts). A block the user toggled keeps that
 * choice instead (lib/block-expansion.ts).
 */

export const COLLAPSE_BLOCK_TYPES = ["toolCalls", "subagents", "extensionMessages", "thinking", "bash"] as const;

export type CollapseBlockType = (typeof COLLAPSE_BLOCK_TYPES)[number];

export type BlockStart = "expanded" | "collapsed";

export type CollapsePolicy = Readonly<Record<CollapseBlockType, BlockStart>>;

/**
 * Today's starts, except subagent results: tool cards (and `!` commands drawn as
 * one) and thinking start collapsed, a displayed extension message expanded, as
 * pi's TUI draws it in full.
 */
export const DEFAULT_COLLAPSE_POLICY: CollapsePolicy = {
  toolCalls: "collapsed",
  subagents: "collapsed",
  extensionMessages: "expanded",
  thinking: "collapsed",
  bash: "collapsed",
};

export const COLLAPSE_POLICY_STORAGE_KEY = "pi-web:collapse-policy";

/** The switch "Expand thinking blocks by default" saved `"true"` here before the policy existed. */
export const LEGACY_THINKING_EXPANDED_KEY = "pi-thinking-expanded";

/**
 * The saved policy (a JSON object of block type to start), or the defaults for
 * whatever it lacks or misspells. With no saved policy, the older thinking
 * switch still decides thinking.
 */
export function parseCollapsePolicy(raw: string | null, legacyThinkingExpanded: string | null): CollapsePolicy {
  if (raw === null) {
    return legacyThinkingExpanded === "true" ? { ...DEFAULT_COLLAPSE_POLICY, thinking: "expanded" } : DEFAULT_COLLAPSE_POLICY;
  }
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    return DEFAULT_COLLAPSE_POLICY;
  }
  if (!saved || typeof saved !== "object") return DEFAULT_COLLAPSE_POLICY;
  const entries = saved as Partial<Record<string, unknown>>;
  const policy = { ...DEFAULT_COLLAPSE_POLICY };
  for (const type of COLLAPSE_BLOCK_TYPES) {
    const start = entries[type];
    if (start === "expanded" || start === "collapsed") policy[type] = start;
  }
  return policy;
}

/** pi-web's `Agent` and the result tool; their cards are subagent reports, not ordinary tool output. */
const SUBAGENT_RESULT_TOOL_NAMES = new Set(["Agent", "get_subagent_result"]);

/** The block type of an agent's tool call card. */
export function toolCallBlockType(toolName: string): CollapseBlockType {
  return SUBAGENT_RESULT_TOOL_NAMES.has(toolName) ? "subagents" : "toolCalls";
}

/** A background subagent's report: pi-web's own and @tintinweb/pi-subagents' (as isMessageGroupAnchor() reads them). */
const SUBAGENT_NOTIFICATION_TYPES = new Set(["pi-web:subagent-notification", "subagent-notification"]);

/**
 * The block type of a custom message, or null for one pi keeps for the model
 * alone (`display` false), which always starts collapsed.
 */
export function customMessageBlockType(message: { customType: string; display?: boolean }): CollapseBlockType | null {
  if (!message.display) return null;
  return SUBAGENT_NOTIFICATION_TYPES.has(message.customType) ? "subagents" : "extensionMessages";
}

/** Whether a block shows expanded: the user's own toggle, else its type's start, else collapsed. */
export function resolveBlockExpanded(type: CollapseBlockType | null, policy: CollapsePolicy, manual: boolean | undefined): boolean {
  if (manual !== undefined) return manual;
  return type !== null && policy[type] === "expanded";
}
