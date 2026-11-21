/**
 * Which transcript blocks start expanded: one choice per block type, kept per
 * browser (hooks/useCollapsePolicy.ts). A block the user toggled keeps that
 * choice instead (lib/block-expansion.ts).
 */

export const COLLAPSE_BLOCK_TYPES = ["toolCalls", "subagents", "extensionMessages", "thinking"] as const;

export type CollapseBlockType = (typeof COLLAPSE_BLOCK_TYPES)[number];

export type BlockStart = "expanded" | "collapsed";

export type CollapsePolicy = Readonly<Record<CollapseBlockType, BlockStart>>;

/**
 * The starts from before the policy, except subagent results: tool cards (`!`
 * commands too) and thinking start collapsed, a displayed extension message
 * expanded, as pi's TUI draws it in full.
 */
export const DEFAULT_COLLAPSE_POLICY: CollapsePolicy = {
  toolCalls: "collapsed",
  subagents: "collapsed",
  extensionMessages: "expanded",
  thinking: "collapsed",
};

/** pi-web's `Agent` and the result tool; their cards are subagent reports, not ordinary tool output. */
const SUBAGENT_RESULT_TOOL_NAMES = new Set(["Agent", "get_subagent_result"]);

/** The block type of a tool call card. */
export function toolCallBlockType(toolName: string): CollapseBlockType {
  return SUBAGENT_RESULT_TOOL_NAMES.has(toolName) ? "subagents" : "toolCalls";
}

/** A background subagent's report: pi-web's own and @tintinweb/pi-subagents' (as isMessageGroupAnchor() reads them). */
const SUBAGENT_NOTIFICATION_TYPES = new Set(["pi-web:subagent-notification", "subagent-notification"]);

/** The block type of a displayed custom message. */
export function customMessageBlockType(customType: string): CollapseBlockType {
  return SUBAGENT_NOTIFICATION_TYPES.has(customType) ? "subagents" : "extensionMessages";
}
