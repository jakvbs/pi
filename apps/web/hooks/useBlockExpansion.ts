import { useState } from "react";
import { getBlockExpansion, setBlockExpansion } from "@/lib/block-expansion";
import type { CollapseBlockType } from "@/lib/collapse-policy";
import { useCollapsePolicy } from "@/hooks/useCollapsePolicy";

/**
 * A transcript block's open state and its toggle: the user's toggle for `key`
 * (kept across remounts), else how the collapse policy starts `type`, which
 * follows a policy change live. A block without a key keeps its toggle here.
 */
export function useBlockExpansion(type: CollapseBlockType, key: string | undefined): [boolean, () => void] {
  const policy = useCollapsePolicy();
  // A new object per toggle, so the toggle always re-renders, also for a keyed block.
  const [ownToggle, setOwnToggle] = useState<{ expanded: boolean }>();
  const manual = key === undefined ? ownToggle?.expanded : getBlockExpansion(key);
  const expanded = manual ?? (policy[type] === "expanded");
  const toggle = () => {
    setBlockExpansion(key, !expanded);
    setOwnToggle({ expanded: !expanded });
  };
  return [expanded, toggle];
}
