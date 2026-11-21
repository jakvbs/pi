import { createStoredChoice } from "./useStoredChoice";
import { DEFAULT_COLLAPSE_POLICY, type BlockStart, type CollapseBlockType, type CollapsePolicy } from "@/lib/collapse-policy";

// One stored choice per block type; anything but "expanded" or "collapsed" reads as the type's default.
function storedStart(type: CollapseBlockType) {
  const fallback = DEFAULT_COLLAPSE_POLICY[type];
  const parse = (raw: string | null): BlockStart => (raw === "expanded" || raw === "collapsed" ? raw : fallback);
  return createStoredChoice(`pi-web:collapse-policy:${type}`, parse, fallback);
}

const starts = {
  toolCalls: storedStart("toolCalls"),
  subagents: storedStart("subagents"),
  extensionMessages: storedStart("extensionMessages"),
  thinking: storedStart("thinking"),
};

/** Saves how one block type starts; mounted blocks nobody toggled follow at once. */
export function setBlockStart(type: CollapseBlockType, start: BlockStart): void {
  starts[type].set(start);
}

/** The per-browser collapse policy; the server renders the defaults. */
export function useCollapsePolicy(): CollapsePolicy {
  return {
    toolCalls: starts.toolCalls.use(),
    subagents: starts.subagents.use(),
    extensionMessages: starts.extensionMessages.use(),
    thinking: starts.thinking.use(),
  };
}
