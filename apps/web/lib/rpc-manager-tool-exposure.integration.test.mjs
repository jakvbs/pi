import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper, resolveActiveToolNames } = await jiti.import("./rpc-manager.ts");
const { appendSessionToolSelection } = await jiti.import("./session-tool-selection.ts");
const { createProjectCommandBashExtension, createProjectCommandPowerShellExtension } = await jiti.import("./project-command-env.ts");
const { PRESET_DEFAULT } = await jiti.import("./tool-presets.ts");

const READ_ONLY = ["read", "grep", "find", "ls"];
const HOST_BASH_PATH = "<inline:pi-web-project-command-environment>";

const lookupExtension = {
  name: "lookup",
  factory: (pi) => {
    pi.registerTool({
      name: "lookup",
      label: "lookup",
      description: "an extension tool pi activates on registration",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "found" }], details: undefined };
      },
    });
  },
};

// Two extension tools that register with `defaultActive: false`.
function inactiveTool(name) {
  return {
    name,
    label: name,
    description: `${name}, registered inactive`,
    parameters: { type: "object", properties: {} },
    defaultActive: false,
    async execute() {
      return { content: [{ type: "text", text: name }], details: undefined };
    },
  };
}

const inactiveExtension = {
  name: "inactive",
  factory: (pi) => {
    pi.registerTool(inactiveTool("alpha"));
    pi.registerTool(inactiveTool("beta"));
  },
};

// On reload it swaps the two inactive tools.
const reloadSwitchExtension = {
  name: "reload-switch",
  factory: (pi) => {
    pi.on("session_start", (event) => {
      if (event.reason !== "reload") return;
      pi.setActiveTools([...pi.getActiveTools().filter((name) => name !== "beta"), "alpha"]);
    });
  },
};

async function createSession(dir, settings = {}, extensionFactories = []) {
  const faux = fauxProvider({ models: [{ id: "faux-tools" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory(settings);
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    extensionFactories: [inactiveExtension, lookupExtension, ...extensionFactories],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    model: faux.getModel("faux-tools"),
    sessionManager: SessionManager.inMemory(dir),
    settingsManager,
    resourceLoader,
  });
  return { session, faux };
}

function sorted(names) {
  return [...names].sort();
}

test("a pinned preset neither activates an inactive tool nor drops the one defaultTools adds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tool-activation-"));
  try {
    const plain = await createSession(dir);
    const initial = plain.session.getActiveToolNames();
    assert.deepEqual(sorted(initial), ["bash", "edit", "lookup", "read", "write"]);
    assert.deepEqual(
      sorted(resolveActiveToolNames(plain.session, READ_ONLY, initial)),
      ["find", "grep", "lookup", "ls", "read"],
    );
    plain.session.dispose();

    const withAlpha = await createSession(dir, { defaultTools: ["+alpha"] });
    const initialWithAlpha = withAlpha.session.getActiveToolNames();
    assert.ok(initialWithAlpha.includes("alpha"));
    assert.deepEqual(
      sorted(resolveActiveToolNames(withAlpha.session, READ_ONLY, initialWithAlpha)),
      ["alpha", "find", "grep", "lookup", "ls", "read"],
    );
    withAlpha.session.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Pi Web's environment-sanitizing bash, which normal sessions load in place of pi's own.
function hostBashExtension(dir) {
  return createProjectCommandBashExtension({
    cwd: dir,
    settings: { getShellCommandPrefix: () => undefined, getShellPath: () => undefined },
  });
}

test("Pi Web's bash is active only when named, as pi's built-in bash is (#1235)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-host-bash-"));
  const bashSource = (session) => session.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.path;
  try {
    // pi's default tools name bash, so the sanitized one is on.
    const plain = await createSession(dir, {}, [hostBashExtension(dir)]);
    assert.deepEqual(sorted(plain.session.getActiveToolNames()), ["bash", "edit", "lookup", "read", "write"]);
    assert.equal(bashSource(plain.session), HOST_BASH_PATH);
    plain.session.dispose();

    for (const [defaultTools, expected] of [
      [["read"], ["lookup", "read"]],
      [["alpha"], ["alpha", "lookup"]],
      [["-bash"], ["edit", "lookup", "read", "write"]],
    ]) {
      const { session } = await createSession(dir, { defaultTools }, [hostBashExtension(dir)]);
      assert.deepEqual(sorted(session.getActiveToolNames()), expected, defaultTools.join());
      // A reload registers every extension tool again.
      await session.reload();
      assert.deepEqual(sorted(session.getActiveToolNames()), expected, defaultTools.join());
      session.dispose();
    }

    // A preset names bash, which turns the sanitized one on.
    const { session } = await createSession(dir, { defaultTools: ["read"] }, [hostBashExtension(dir)]);
    session.setActiveToolsByName(resolveActiveToolNames(session, PRESET_DEFAULT, session.getActiveToolNames()));
    assert.deepEqual(sorted(session.getActiveToolNames()), ["bash", "edit", "lookup", "read", "write"]);
    assert.equal(bashSource(session), HOST_BASH_PATH);
    // pi's own reload (an extension command's ctx.reload()) keeps it off under a pin without it.
    session.setActiveToolsByName(resolveActiveToolNames(session, READ_ONLY, session.getActiveToolNames()));
    await session.reload();
    assert.deepEqual(sorted(session.getActiveToolNames()), ["find", "grep", "lookup", "ls", "read"]);
    session.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("with PowerShell switched on, the active powershell is Pi Web's sanitizing one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-host-powershell-"));
  const toolSource = (session, name) => session.getAllTools().find((tool) => tool.name === name)?.sourceInfo.path;
  const hostShells = () => [hostBashExtension(dir), createProjectCommandPowerShellExtension({ cwd: dir })];
  try {
    // The PowerShell switch writes powershell in place of bash (lib/powershell-settings.ts).
    const { session } = await createSession(dir, { defaultTools: ["read", "powershell", "edit", "write"] }, hostShells());
    assert.deepEqual(sorted(session.getActiveToolNames()), ["edit", "lookup", "powershell", "read", "write"]);
    assert.equal(toolSource(session, "powershell"), "<inline:pi-web-project-command-powershell>");
    await session.reload();
    assert.equal(toolSource(session, "powershell"), "<inline:pi-web-project-command-powershell>");
    session.dispose();

    // Not named, it stays off, as pi's built-in powershell does.
    const plain = await createSession(dir, {}, hostShells());
    assert.deepEqual(sorted(plain.session.getActiveToolNames()), ["bash", "edit", "lookup", "read", "write"]);
    plain.session.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("navigating to an older branch keeps the Read-only pin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tool-navigation-"));
  const { session, faux } = await createSession(dir);
  const wrapper = new AgentSessionWrapper(session);
  try {
    faux.setResponses([
      () => fauxAssistantMessage([fauxText("first")]),
      () => fauxAssistantMessage([fauxText("second")]),
    ]);
    await session.prompt("first");
    const firstLeafId = session.sessionManager.getLeafId();

    appendSessionToolSelection(session.sessionManager, READ_ONLY);
    wrapper.setActiveToolSelection(READ_ONLY);
    await session.prompt("second");
    const secondLeafId = session.sessionManager.getLeafId();
    const pinnedTools = ["find", "grep", "lookup", "ls", "read"];
    assert.deepEqual(sorted(session.getActiveToolNames()), pinnedTools);

    // On its own, pi restores the older branch's loadout: write is back.
    await session.navigateTree(firstLeafId, {});
    assert.deepEqual(sorted(session.getActiveToolNames()), ["bash", "edit", "lookup", "read", "write"]);
    await session.navigateTree(secondLeafId, {});
    assert.deepEqual(sorted(session.getActiveToolNames()), pinnedTools);

    assert.deepEqual(await wrapper.send({ type: "navigate_tree", targetId: firstLeafId }), { cancelled: false });
    assert.equal(session.sessionManager.getLeafId(), firstLeafId);
    assert.deepEqual(sorted(session.getActiveToolNames()), pinnedTools);
  } finally {
    wrapper.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reload keeps the pinned coding tools and what extensions chose while they restarted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tool-reload-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  // The wrapper's reload reads project trust from the agent directory.
  process.env.PI_CODING_AGENT_DIR = dir;
  const { session } = await createSession(dir, {}, [reloadSwitchExtension]);
  const wrapper = new AgentSessionWrapper(session);
  try {
    wrapper.beginExtensionBinding();
    await wrapper.waitUntilReady();
    wrapper.setActiveToolSelection(READ_ONLY);
    session.setActiveToolsByName([...session.getActiveToolNames(), "beta"]);
    assert.deepEqual(sorted(session.getActiveToolNames()), ["beta", "find", "grep", "lookup", "ls", "read"]);

    assert.deepEqual(await wrapper.send({ type: "reload" }), { success: true });

    // The extension switched beta off and alpha on; the pin still holds.
    assert.deepEqual(sorted(session.getActiveToolNames()), ["alpha", "find", "grep", "lookup", "ls", "read"]);
  } finally {
    wrapper.destroy();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
});
