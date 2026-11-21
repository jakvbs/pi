import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  type ProjectTrustStoreEntry,
} from "@earendil-works/pi-coding-agent";
import type { ProjectTrustStatus } from "./api-types";
import { samePath } from "./paths";

/** The folder as `trust.json` keys it: resolved, then its real path when it exists. */
function trustKeyPath(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function describeDecision(
  cwd: string,
  entry: ProjectTrustStoreEntry | null,
): Pick<ProjectTrustStatus, "decision" | "decisionPath" | "inherited"> {
  if (!entry) return { decision: null, inherited: false };
  return {
    decision: entry.decision,
    decisionPath: entry.path,
    inherited: !samePath(entry.path, trustKeyPath(cwd)),
  };
}

/**
 * Whether the project at `cwd` needs trust and is trusted, and the decision
 * that answers it. The store resolves the nearest decision, exact or
 * inherited from an ancestor, so `decision` and `decisionPath` tell exact
 * trust from trust through a parent, and no decision from an explicit `false`,
 * which `trusted` alone cannot. They are read for a folder that requires no
 * trust too, which is trusted unless a saved decision says otherwise, as pi
 * 1.5 resolves it (earendil-works/pi#10947): a fresh folder and one inside a
 * trusted tree report `trusted: true`, one under an explicit `false` reports
 * `trusted: false`. Such a folder never failed on an unreadable `trust.json`
 * before, and callers that only need `trusted` still must not, so that failure
 * is reported in `decisionError` instead, with `trusted: true`.
 */
export function getProjectTrustStatus(cwd: string, agentDir: string): ProjectTrustStatus {
  const requiresTrust = Boolean(cwd) && hasTrustRequiringProjectResources(cwd);
  const trustStore = new ProjectTrustStore(agentDir);
  if (!requiresTrust) {
    if (!cwd) return { requiresTrust: false, trusted: true, decision: null, inherited: false };
    try {
      const entry = trustStore.getEntry(cwd);
      return { requiresTrust: false, trusted: entry?.decision ?? true, ...describeDecision(cwd, entry) };
    } catch (error) {
      return {
        requiresTrust: false,
        trusted: true,
        decision: null,
        inherited: false,
        decisionError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const entry = trustStore.getEntry(cwd);
  return {
    requiresTrust: true,
    trusted: entry?.decision === true,
    ...describeDecision(cwd, entry),
  };
}

export function trustProject(cwd: string, agentDir: string): ProjectTrustStatus {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return status;

  new ProjectTrustStore(agentDir).set(cwd, true);
  // Built from what was just written, not read back: a second read can fail
  // (the lock held past the store's wait), and the route would then report a
  // decision already on disk as a failure and skip rebuilding the cwd's wrappers.
  return { requiresTrust: true, trusted: true, decision: true, decisionPath: trustKeyPath(cwd), inherited: false };
}

/**
 * Reload options that gate project-local, trust-requiring resources — a
 * repository's `.pi/extensions`, project `.pi/settings.json` extension
 * entries, and `.agents/skills` — behind the SDK's project-trust store.
 *
 * Pi Web *executes* project extensions when it builds session services: their
 * factory runs on import and their `session_start` handlers run on startup.
 * Without a trust gate, merely opening an untrusted repository in Pi Web runs
 * repository-controlled code locally (issue #236). The SDK's resource loader
 * only imports project extensions once `resolveProjectTrust` resolves true, so
 * denying trust keeps them dormant.
 *
 * Pi Web and the `pi` CLI share the same trust store. Projects with gated
 * resources default to untrusted until either client records a trust decision.
 * Returns `undefined` when the project has no trust-requiring resources,
 * leaving ordinary projects on their existing load path.
 */
export function projectTrustReloadOptions(
  cwd: string,
  agentDir: string,
): { resolveProjectTrust: () => Promise<boolean> } | undefined {
  if (!cwd || !hasTrustRequiringProjectResources(cwd)) return undefined;
  const trustStore = new ProjectTrustStore(agentDir);
  return { resolveProjectTrust: async () => trustStore.get(cwd) === true };
}
