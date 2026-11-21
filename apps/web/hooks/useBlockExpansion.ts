import { useState } from "react";
import { getBlockExpansion, setBlockExpansion } from "@/lib/block-expansion";
import { resolveBlockExpanded, type CollapseBlockType } from "@/lib/collapse-policy";
import { useCollapsePolicy } from "@/hooks/useCollapsePolicy";

/**
 * A transcript block's open state and its toggle: the user's toggle for `key`
 * (kept across remounts), else how the collapse policy starts `type`, which
 * follows a policy change live. `type` null starts collapsed.
 */
export function useBlockExpansion(type: CollapseBlockType | null, key: string | undefined): [boolean, () => void] {
  const policy = useCollapsePolicy();
  const [choice, setChoice] = useState(() => ({ key, manual: getBlockExpansion(key) }));
  // A reused block for another key (a list re-keyed by index) takes that key's toggle.
  if (choice.key !== key) setChoice({ key, manual: getBlockExpansion(key) });
  const manual = choice.key === key ? choice.manual : getBlockExpansion(key);
  const expanded = resolveBlockExpanded(type, policy, manual);
  const toggle = () => {
    setBlockExpansion(key, !expanded);
    setChoice({ key, manual: !expanded });
  };
  return [expanded, toggle];
}
