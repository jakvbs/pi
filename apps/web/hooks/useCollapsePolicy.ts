import { useSyncExternalStore } from "react";
import {
  COLLAPSE_POLICY_STORAGE_KEY,
  DEFAULT_COLLAPSE_POLICY,
  LEGACY_THINKING_EXPANDED_KEY,
  parseCollapsePolicy,
  type BlockStart,
  type CollapseBlockType,
  type CollapsePolicy,
} from "@/lib/collapse-policy";

function readStoredPolicy(): CollapsePolicy {
  try {
    const storage = window.localStorage;
    return parseCollapsePolicy(storage.getItem(COLLAPSE_POLICY_STORAGE_KEY), storage.getItem(LEGACY_THINKING_EXPANDED_KEY));
  } catch {
    return DEFAULT_COLLAPSE_POLICY;
  }
}

let policy: CollapsePolicy | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): CollapsePolicy {
  if (policy === null) policy = readStoredPolicy();
  return policy;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

// Another tab chose; `key` is null when that tab cleared its storage.
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== COLLAPSE_POLICY_STORAGE_KEY) return;
  policy = readStoredPolicy();
  notify();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
    // Nobody listened for another tab's choice meanwhile.
    policy = readStoredPolicy();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

/** Saves how one block type starts; mounted blocks nobody toggled follow at once. */
export function setBlockStart(type: CollapseBlockType, start: BlockStart): void {
  const current = getSnapshot();
  if (current[type] === start) return;
  policy = { ...current, [type]: start };
  try {
    window.localStorage.setItem(COLLAPSE_POLICY_STORAGE_KEY, JSON.stringify(policy));
    // The saved policy now holds the thinking choice the older switch kept.
    window.localStorage.removeItem(LEGACY_THINKING_EXPANDED_KEY);
  } catch {
    // Applies in memory even if the browser cannot save it.
  }
  notify();
}

/** The per-browser collapse policy; the server renders the defaults. */
export function useCollapsePolicy(): CollapsePolicy {
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_COLLAPSE_POLICY);
}
