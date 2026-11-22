import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import type { SubagentProfile } from "./subagents";

export interface SubagentProfilesResponse {
  profiles: SubagentProfile[];
}

export interface SubagentSettingsResponse {
  enabled: boolean;
  maxConcurrent: number;
}

export interface ToolSettingsResponse {
  isWindows: boolean;
  powerShellEnabled: boolean;
  /** The built-in tools the global defaultTools starts sessions with; "bash" is the active shell. */
  builtinTools: string[];
}

export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
}

export type SkillInstallScope = "global" | "project";

export interface SkillInstallInfo {
  package: string;
  scope: SkillInstallScope;
  source: string;
  sourceType?: string;
  skillsShUrl?: string;
  skillPath?: string;
  ref?: string;
  versionHash?: string;
  canCheckForUpdates: boolean;
}

export type SkillUpdateState =
  | "up-to-date"
  | "update-available"
  | "unsupported"
  | "error";

export interface SkillUpdateResult {
  package: string;
  scope: SkillInstallScope;
  state: SkillUpdateState;
  currentVersion?: string;
  latestVersion?: string;
  message?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
  install?: SkillInstallInfo;
}

export interface SkillsResponse {
  skills: SkillInfo[];
  diagnostics: ResourceDiagnostic[];
  projectResourcesLoaded: boolean;
}

export interface SkillContentResponse {
  content: string;
}

/** One file of a bulk `PATCH /api/skills`; `error` means it was left as it was. */
export interface SkillToggleResult {
  filePath: string;
  error?: string;
}

export interface ProjectTrustStatus {
  requiresTrust: boolean;
  trusted: boolean;
  /**
   * The nearest decision `trust.json` records for this folder or an ancestor,
   * null when there is none. Read for a folder that requires no trust too, so
   * a fresh folder (no decision anywhere) can be told from one inside a
   * trusted or untrusted tree.
   */
  decision: boolean | null;
  /** The folder that decision is recorded for, as `trust.json` keys it (its real path). */
  decisionPath?: string;
  /** The decision is recorded for an ancestor, so every folder below it shares it. */
  inherited: boolean;
  /**
   * Set only for a folder that requires no trust when `trust.json` could not
   * be read; `decision` is then null although one may exist. A folder that
   * requires trust reports the failure as an error instead.
   */
  decisionError?: string;
}

/**
 * Why a route refused a request: `/api/project-trust` or `/api/tools/settings`.
 * Every refusal carries `{ error, reason }`: `error` is an English diagnostic,
 * `reason` a code the page translates.
 */
export type RouteRefusalReason =
  /** `cwd` is empty or not an absolute path. */
  | "cwd-invalid"
  /** `cwd` is outside the folders Pi Web may read, has a `..` segment, or does not exist. */
  | "cwd-denied"
  /** `cwd` is not a directory (anymore). */
  | "cwd-not-directory"
  /** A mutating request that did not come from Pi Web's own page (origin or host check). */
  | "request-denied"
  /** A mutating request whose body is not sent as JSON. */
  | "content-type"
  /** `trust.json` cannot be read, or is locked by another process: 500 from `GET /api/project-trust`. */
  | "trust-unreadable"
  /** The project has no resources that need trust (anymore), so there is nothing to trust. */
  | "trust-not-required"
  /** A session in the folder is running, and trusting would rebuild it mid-run. */
  | "session-busy"
  /** The body is not a request the route can act on. */
  | "invalid-request"
  /** Reading failed unexpectedly; `error` says how. */
  | "internal";

export interface RouteErrorResponse {
  error: string;
  reason: RouteRefusalReason;
}

/** GET /api/project-trust: the trust status. */
export type ProjectTrustResponse = ProjectTrustStatus;

/** GET /api/project-trust when `trust.json` cannot be read (500). */
export interface ProjectTrustUnreadableResponse {
  error: string;
  reason: "trust-unreadable";
}

export interface AppUpdateResponse {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
}

export interface PushConfigResponse {
  publicKey: string;
}

export type PluginScope = "global" | "project";
export type PluginResourceKind = "extension" | "skill" | "prompt" | "theme";

export interface PluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

export interface PluginDiagnostic {
  type: "warning" | "error";
  message: string;
  source?: string;
  path?: string;
}

export interface PluginResourceInfo {
  kind: PluginResourceKind;
  name: string;
  path: string;
  relativePath: string;
}

export interface PluginStandaloneExtensionInfo extends PluginResourceInfo {
  kind: "extension";
  scope: PluginScope;
  enabled: boolean;
}

export interface PluginPackageInfo {
  source: string;
  scope: PluginScope;
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  description?: string;
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
  status: "loaded" | "installed" | "missing" | "disabled";
}

export interface PluginsResponse {
  packages: PluginPackageInfo[];
  standaloneExtensions: PluginStandaloneExtensionInfo[];
  totals: PluginResourceCounts;
  diagnostics: PluginDiagnostic[];
  projectResourcesLoaded: boolean;
}

/** One package of a bulk enable/disable; `error` means it was left as it was. */
export interface PluginToggleResult {
  source: string;
  scope: PluginScope;
  error?: string;
}

export interface PluginsBulkResponse extends PluginsResponse {
  results: PluginToggleResult[];
}
