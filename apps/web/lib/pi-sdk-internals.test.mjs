import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { StdioTransport } from "@earendil-works/pi-mcp";

import { loadPiSdkInternals } from "./pi-sdk-internals.ts";

// pi-web relies on more than the SDK's types say: arity, class-ness and the
// methods it calls. An SDK change that breaks one of them must fail here.
const EXPECTED_MEMBERS = {
  McpServerConnection: {
    kind: "class",
    length: 1,
    methods: ["getClient", "callTool", "reconnect", "signOut", "oauthSettings", "close"],
  },
  createDefaultTransport: { kind: "function", length: 3 },
  StdioTransport: {
    kind: "class",
    length: 1,
    methods: ["start", "send", "close", "onMessage", "onError", "onClose"],
  },
  loadMcpConfig: { kind: "function", length: 1 },
  addMcpServerConfig: { kind: "function", length: 3 },
  updateMcpServerConfig: { kind: "function", length: 3 },
  removeMcpServerConfig: { kind: "function", length: 2 },
  validateMcpServerConfig: { kind: "function", length: 2 },
  getMcpToolExposure: { kind: "function", length: 2 },
  signInMcpServer: { kind: "function", length: 1 },
  McpOAuthCredentialStore: { kind: "class", length: 2, methods: ["forServer", "tokens", "remove"] },
  McpSignInCancelledError: { kind: "class", length: 0 },
  resolveConfigValueOrThrow: { kind: "function", length: 3 },
  resolveHeadersOrThrow: { kind: "function", length: 3 },
  getConfigValueEnvVarNames: { kind: "function", length: 1 },
  isCommandConfigValue: { kind: "function", length: 1 },
};

function isClass(value) {
  return typeof value === "function" && /^class[\s{]/.test(Function.prototype.toString.call(value));
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-sdk-internals-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function loadedInternals() {
  const internals = await loadPiSdkInternals();
  assert.equal(internals.ok, true, internals.reason);
  return internals;
}

test("loads every MCP internal from the SDK pi-web runs", async () => {
  const internals = await loadedInternals();
  for (const [name, expected] of Object.entries(EXPECTED_MEMBERS)) {
    const member = internals[name];
    assert.equal(typeof member, "function", `${name} is missing`);
    assert.equal(isClass(member), expected.kind === "class", `${name} is not a ${expected.kind}`);
    assert.equal(member.length, expected.length, `${name} takes ${member.length} parameters`);
    for (const method of expected.methods ?? []) {
      assert.equal(typeof member.prototype[method], "function", `${name}.prototype.${method} is missing`);
    }
  }
  const exposed = Object.keys(internals).filter((key) => key !== "ok").sort();
  assert.deepEqual(exposed, Object.keys(EXPECTED_MEMBERS).sort());
});

test("every copy of the module hands out the one SDK pi-web imports", async () => {
  // Next.js bundles route handlers into separate module graphs and hot reload
  // re-evaluates modules; the SDK's `instanceof` checks need one copy of it.
  const copy = await import(`./pi-sdk-internals.ts?copy=${Date.now()}`);
  assert.notEqual(copy.loadPiSdkInternals, loadPiSdkInternals);
  const [internals, copied] = [await loadedInternals(), await copy.loadPiSdkInternals()];
  for (const name of Object.keys(EXPECTED_MEMBERS)) assert.equal(copied[name], internals[name], name);
  assert.equal(internals.StdioTransport, StdioTransport);
});

test("the SDK builds stdio transports from the StdioTransport class it exposes", async () => {
  const { createDefaultTransport, StdioTransport } = await loadedInternals();
  const transport = createDefaultTransport(
    {
      name: "contract",
      config: { command: "~/server", args: ["~/data", "--flag"], cwd: "sub", env: { TOKEN: "$${literal}" } },
      source: "test",
    },
    "/work",
    undefined,
  );

  assert.ok(transport instanceof StdioTransport);
  assert.equal(transport.pid, undefined, "constructing a transport spawns nothing");
  // lib/mcp-transport.ts carries these over and replaces `env`, which must
  // hold only the entry's own resolved values.
  assert.deepEqual(Object.keys(transport.options).sort(), ["args", "command", "cwd", "env", "stderr"]);
  assert.deepEqual(transport.options.env, { TOKEN: "${literal}" });
  assert.equal(transport.options.inheritEnv, undefined);
  assert.equal(transport.options.cwd, resolve("/work", "sub"));
  assert.equal(transport.options.stderr, "pipe");
});

test("config, validation and value helpers keep the shapes pi-web relies on", async () => {
  const internals = await loadedInternals();

  assert.deepEqual(internals.validateMcpServerConfig("files", { command: "npx", args: ["server"] }), {
    command: "npx",
    args: ["server"],
  });
  assert.equal(typeof internals.validateMcpServerConfig("broken", { command: 1 }), "string");
  assert.equal(internals.getMcpToolExposure({ command: "npx" }, "read"), "codemode");

  assert.deepEqual(internals.getConfigValueEnvVarNames("Bearer ${TOKEN} $USER $${ESCAPED}"), ["TOKEN", "USER"]);
  assert.deepEqual(internals.getConfigValueEnvVarNames("!printenv TOKEN"), []);
  assert.equal(internals.isCommandConfigValue("!printenv TOKEN"), true);
  assert.equal(internals.isCommandConfigValue("$!literal"), false);
  assert.equal(internals.resolveConfigValueOrThrow("a-${VALUE}", "test", { VALUE: "b" }), "a-b");
  assert.throws(
    () => internals.resolveConfigValueOrThrow("${PI_WEB_INTERNALS_TEST_MISSING}", "test value"),
    /test value from environment variable: PI_WEB_INTERNALS_TEST_MISSING/,
  );
  assert.ok(new internals.McpSignInCancelledError() instanceof Error);

  await withTempDir(async (dir) => {
    const path = join(dir, "mcp.json");
    assert.equal(internals.addMcpServerConfig(path, "files", { command: "npx" }), false);
    internals.updateMcpServerConfig(path, "files", { enabled: false });
    const loaded = internals.loadMcpConfig({ agentDir: dir, cwd: dir, projectTrusted: false });
    assert.deepEqual(loaded, {
      servers: [{ name: "files", config: { command: "npx", enabled: false }, source: path, scope: "global" }],
      errors: [],
    });
    assert.equal(internals.removeMcpServerConfig(path, "files"), true);
    assert.equal(internals.removeMcpServerConfig(path, "files"), false);
  });
});

// lib/mcp-host.ts connects project entries on the SDK's word alone, as the pi
// CLI does, so this read is what keeps an untrusted repository's servers off.
test("a project's mcp.json is read only once the project is trusted, and replaces global entries", async () => {
  const internals = await loadedInternals();

  await withTempDir(async (dir) => {
    const agentDir = join(dir, "agent");
    const project = join(dir, "project");
    await mkdir(agentDir);
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { files: { command: "global-files" } } }));
    await writeFile(
      join(project, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { files: { command: "repo-files" }, repo: { command: "repo-srv" } } }),
    );
    const read = (projectTrusted) =>
      internals.loadMcpConfig({ agentDir, cwd: project, projectTrusted }).servers
        .map(({ name, scope, config }) => [name, scope, config.command]);

    assert.deepEqual(read(false), [["files", "global", "global-files"]]);
    assert.deepEqual(read(true), [["files", "project", "repo-files"], ["repo", "project", "repo-srv"]]);
  });
});
