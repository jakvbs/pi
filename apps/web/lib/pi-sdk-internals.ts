import {
  addMcpServerConfig,
  createDefaultTransport,
  getConfigValueEnvVarNames,
  getMcpToolExposure,
  isCommandConfigValue,
  loadMcpConfig,
  McpOAuthCredentialStore as SdkMcpOAuthCredentialStore,
  McpServerConnection as SdkMcpServerConnection,
  removeMcpServerConfig,
  resolveConfigValueOrThrow,
  resolveHeadersOrThrow,
  signInMcpServer,
  updateMcpServerConfig,
  validateMcpServerConfig,
  type LoadedMcpConfig,
  type McpExposure,
  type McpExtensionOptions,
  type McpServerConfig,
  type McpServerEntry,
  type McpTransportFactory,
} from "@earendil-works/pi-coding-agent";
import { StdioTransport as McpStdioTransport } from "@earendil-works/pi-mcp";
import { McpSignInCancelledError } from "@earendil-works/pi-mcp/oauth";

// The SDK's MCP host API (ADR 0006): the connection class, the stdio transport,
// the `mcp.json` editor, OAuth sign-in and config values, imported from the
// SDK root and pi-mcp, which the pi fork exports. The interfaces below are the
// parts pi-web uses, so `tsc` fails when the SDK changes one of them, and
// `lib/pi-sdk-internals.test.mjs` pins the behaviour pi-web relies on.

/** What a transport factory returns: pi-mcp's `McpTransport`, which the SDK root does not export. */
export type McpTransport = ReturnType<McpTransportFactory>;

/** The SDK's `McpOAuthCredentialStore`: per-server OAuth state in `<agent-dir>/mcp-auth.json`. */
export type McpOAuthCredentialStore = NonNullable<McpExtensionOptions["credentials"]>;

/** One server's slice of the credential store. */
export type McpOAuthServerStore = ReturnType<McpOAuthCredentialStore["forServer"]>;

/** pi-mcp's `StdioTransportOptions`. */
export interface StdioTransportOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  stderr?: "pipe" | "inherit";
  onStderr?: (chunk: string) => void;
  maxMessageBytes?: number;
  maxStderrBytes?: number;
  /** Time to wait for the server to exit after SIGTERM before sending SIGKILL. Default: 2000. */
  closeTimeoutMs?: number;
}

/** pi-mcp's `StdioTransport`. */
export interface StdioTransport extends McpTransport {
  readonly options: Readonly<StdioTransportOptions>;
  readonly pid: number | undefined;
  readonly stderr: string;
}

/** pi-mcp's `Tool`, as a server lists it in `tools/list`. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execution?: { taskSupport?: "forbidden" | "optional" | "required" };
  _meta?: Record<string, unknown>;
}

/** pi-mcp's `OAuthChallenge`, parsed from a server's `WWW-Authenticate` header. */
export interface McpOAuthChallenge {
  resourceMetadataUrl?: URL;
  scope?: string;
  error?: string;
  errorDescription?: string;
}

/** The SDK's `McpOAuthSettings`; `clientSecret` is already resolved. */
export interface McpOAuthSettings {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
  clientName?: string;
  /** How pi identifies itself without `clientId`: its Client ID Metadata Document when supported (pi 1.5's default), dynamic registration, or always the document. */
  clientRegistration?: "auto" | "dcr" | "cimd";
  authServerMetadataUrl?: URL;
}

/** The part of pi-mcp's `McpClient` that pi-web reads. */
export interface McpClient {
  readonly connectionState: "idle" | "connecting" | "connected" | "closed";
  readonly serverInfo: { name: string; version: string; title?: string } | undefined;
  readonly instructions: string | undefined;
  readonly protocolVersion: string | undefined;
  close(): Promise<void>;
}

export type McpServerState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";

export interface McpServerConnectionOptions {
  entry: McpServerEntry;
  cwd: string;
  createTransport: McpTransportFactory;
  credentials: McpOAuthCredentialStore;
  /** The current token of a pi provider, for servers with `auth.provider`. */
  providerToken?: (provider: string) => Promise<string | undefined>;
  onTools: (connection: McpServerConnection) => void;
  /** Called when `state`, `error`, or `tools` change. */
  onChange?: (connection: McpServerConnection) => void;
}

/** The part of the SDK's `McpServerConnection` that pi-web uses. */
export interface McpServerConnection {
  readonly entry: McpServerEntry;
  state: McpServerState;
  error: string | undefined;
  tools: McpTool[];
  /** Whether the server offers resources; the SDK lists them only when a resource tool asks. */
  hasResources: boolean;
  /** Server instructions from `initialize`. */
  instructions: string | undefined;
  /** Last OAuth challenge from the server; sign-in uses its resource metadata URL and scope. */
  challenge: McpOAuthChallenge | undefined;
  readonly name: string;
  readonly timeoutMs: number;
  /** Server URL when the server authenticates with OAuth. */
  readonly oauthUrl: string | undefined;
  /** Resolves `oauth.clientSecret`, which may run a `!command`. */
  oauthSettings(): McpOAuthSettings;
  getClient(): Promise<McpClient>;
  reconnect(): Promise<void>;
  signOut(): Promise<void>;
  close(): Promise<void>;
}

export interface McpSignInPrompt {
  /** Show the authorization URL to the user. */
  showAuthorizationUrl(url: URL): void;
  /**
   * Ask for the redirect URL from the browser address bar. Aborted once the loopback callback
   * arrives. Resolves to `undefined` or an empty string when the user cancels.
   */
  promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

export interface McpSignInOptions {
  serverUrl: string;
  /** Sign-in refreshes stored tokens under its refresh lock. */
  store: McpOAuthServerStore;
  settings: McpOAuthSettings;
  challenge?: McpOAuthChallenge;
  prompt: McpSignInPrompt;
  /** Stops the sign-in at any step with `McpSignInCancelledError` (pi 1.1). */
  signal?: AbortSignal;
}

/** The settings `/mcp` changes; `enabled: true` and `exposure: "codemode"` remove the key, except in an override. */
export interface McpServerConfigPatch {
  enabled?: boolean;
  exposure?: McpExposure;
}

export interface PiSdkInternals {
  McpServerConnection: new (options: McpServerConnectionOptions) => McpServerConnection;
  createDefaultTransport: McpTransportFactory;
  /** The class the SDK's `McpServerConnection` recognizes as a stdio transport. */
  StdioTransport: new (options: StdioTransportOptions) => StdioTransport;
  loadMcpConfig: (options: { agentDir: string; cwd: string; projectTrusted: boolean }) => LoadedMcpConfig;
  /** Returns true when an entry with the same name was replaced. */
  addMcpServerConfig: (path: string, name: string, config: McpServerConfig) => boolean;
  /** With `override`, a missing entry is added as a project override (pi 1.0.1). */
  updateMcpServerConfig: (path: string, name: string, patch: McpServerConfigPatch, options?: { override?: boolean }) => void;
  /** Returns false when the file does not define the server. */
  removeMcpServerConfig: (path: string, name: string) => boolean;
  /** Returns the config, or an error message. */
  validateMcpServerConfig: (name: string, value: unknown) => McpServerConfig | string;
  getMcpToolExposure: (config: McpServerConfig, toolName: string) => McpExposure;
  signInMcpServer: (options: McpSignInOptions) => Promise<void>;
  /** pi-web always uses the default store, `mcp-auth.json` in the agent directory. */
  McpOAuthCredentialStore: new () => McpOAuthCredentialStore;
  McpSignInCancelledError: new () => Error;
  resolveConfigValueOrThrow: (config: string, description: string, env?: Record<string, string>) => string;
  resolveHeadersOrThrow: (
    headers: Record<string, string> | undefined,
    description: string,
    env?: Record<string, string>,
  ) => Record<string, string> | undefined;
  /** Variables a `${NAME}` / `$NAME` value references; none for a `!command` value. */
  getConfigValueEnvVarNames: (config: string) => string[];
  isCommandConfigValue: (config: string) => boolean;
}

// The result keeps upstream pi-web's shape, whose callers turn MCP off with the
// reason when the npm SDK's unexported modules do not load. On the fork the
// imports above either load or fail the module.
export type PiSdkInternalsResult = ({ ok: true } & PiSdkInternals) | { ok: false; reason: string };

const LOADED: Promise<PiSdkInternalsResult> = Promise.resolve({
  ok: true,
  McpServerConnection: SdkMcpServerConnection,
  createDefaultTransport,
  StdioTransport: McpStdioTransport,
  loadMcpConfig,
  addMcpServerConfig,
  updateMcpServerConfig,
  removeMcpServerConfig,
  validateMcpServerConfig,
  getMcpToolExposure,
  signInMcpServer,
  McpOAuthCredentialStore: SdkMcpOAuthCredentialStore,
  McpSignInCancelledError,
  resolveConfigValueOrThrow,
  resolveHeadersOrThrow,
  getConfigValueEnvVarNames,
  isCommandConfigValue,
});

/** The SDK's MCP host API. */
export function loadPiSdkInternals(): Promise<PiSdkInternalsResult> {
  return LOADED;
}
