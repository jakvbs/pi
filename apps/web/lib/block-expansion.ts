/**
 * Remembers the transcript blocks the user expanded or collapsed by hand, keyed
 * by the block (a toolCallId; a custom message's or thinking block's own key).
 * A remembered choice wins over the collapse policy (lib/collapse-policy.ts), so
 * changing the policy moves only blocks nobody toggled.
 *
 * A streaming assistant message is rendered from the streaming store, then re-rendered
 * from `messages` after `message_end`, and moves into Process details when the run
 * ends. Each of those hops remounts the block, and so does the session file's
 * read when the message's key cannot pass to its entry (lib/message-keys.ts), as in
 * a run longer than the first page; otherwise the read keeps the block mounted. Plain
 * component state would undo a toggle the user just made. Keeping the choices
 * outside React lets the remounted block start as the user left it without
 * threading state through every message component.
 */
const manualExpansion = new Map<string, boolean>();

/** The user's own choice for a block, or undefined when they never toggled it (or it has no key). */
export function getBlockExpansion(key: string | undefined): boolean | undefined {
  return key === undefined ? undefined : manualExpansion.get(key);
}

/** Records a toggle; a block without a key keeps it in its component only. */
export function setBlockExpansion(key: string | undefined, expanded: boolean): void {
  if (key) manualExpansion.set(key, expanded);
}

/** Forgets every toggle (tests). */
export function clearBlockExpansions(): void {
  manualExpansion.clear();
}
