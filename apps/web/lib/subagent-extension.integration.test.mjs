import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createJiti } from "jiti";

const { createSubagentExtension } = await createJiti(import.meta.url).import("./subagent-extension.ts");

const CONTROL_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];

// Only `get` answers, so the test can tell a call the model issued itself from one that reached
// the runtime from a script.
function recordingRuntime() {
  const calls = [];
  const refuse = (name) => async () => {
    calls.push(name);
    throw new Error(`${name} must not run`);
  };
  return {
    calls,
    runtime: {
      start: refuse("start"),
      resume: refuse("resume"),
      async get(sessionId) {
        calls.push(`get:${sessionId}`);
        return {
          sessionId,
          sessionPath: "/tmp/child.jsonl",
          parentSessionId: "parent-session",
          parentToolCallId: "model-call",
          profile: "explore",
          description: "Find parser",
          task: "Find the parser",
          runInBackground: false,
          status: "completed",
          result: "The parser is in lib/parse.ts.",
          createdAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
        };
      },
      steer: refuse("steer"),
      notifyParent: refuse("notifyParent"),
      markResultConsumed: () => calls.push("markResultConsumed"),
    },
  };
}

// Stands in for codemode: a direct tool that calls other tools through `ctx.executeTool()`.
function nestedCallerExtension(outcomes) {
  return (pi) => {
    pi.registerTool({
      name: "echo",
      label: "echo",
      description: "Return the text it was given.",
      parameters: Type.Object({ text: Type.String() }),
      async execute(_toolCallId, params) {
        return { content: [{ type: "text", text: params.text }], details: undefined };
      },
    });
    pi.registerTool({
      name: "script",
      label: "script",
      description: "Call other tools the way a codemode script does.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const calls = [
          ["echo", { text: "nested calls work" }],
          ["Agent", { prompt: "Find the parser", description: "Find parser" }],
          ["get_subagent_result", { agent_id: "child-session" }],
          ["steer_subagent", { agent_id: "child-session", message: "Stop" }],
        ];
        for (const [name, args] of calls) {
          const outcome = await ctx.executeTool(name, args);
          outcomes.push({
            name,
            isError: outcome.isError,
            text: outcome.result.content.map((block) => block.text).join(""),
          });
        }
        return { content: [{ type: "text", text: "script done" }], details: undefined };
      },
    });
  };
}

async function createSession(dir, faux, extensionFactories, scopedModels) {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory(),
    modelRuntime,
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories,
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(dir),
    model: faux.getModel("faux-model"),
    ...(scopedModels ? { scopedModels: scopedModels(faux) } : {}),
  });
  return session;
}

function textOf(message) {
  return message.content.map((block) => block.text ?? "").join("");
}

// A codemode script must not start, collect, or steer subagents: a run started from a script
// would carry a nested parentToolCallId that no transcript entry has, so the chat could not
// link to its session. The model itself keeps all three tools and can still call them.
test("subagent control tools are declared to the model but cannot be called from another tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-exposure-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const { calls, runtime } = recordingRuntime();
    const outcomes = [];
    session = await createSession(dir, faux, [
      createSubagentExtension(runtime, () => []),
      nestedCallerExtension(outcomes),
    ]);

    const toolsByName = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
    for (const name of CONTROL_TOOLS) assert.equal(toolsByName.get(name)?.exposure, "model-only", name);
    const active = session.getActiveToolNames();
    for (const name of CONTROL_TOOLS) assert.ok(active.includes(name), `${name} should be active`);
    const callable = session.getCallableToolNames();
    assert.ok(callable.includes("echo"));
    for (const name of CONTROL_TOOLS) assert.ok(!callable.includes(name), `${name} should not be callable`);

    let declared = [];
    faux.setResponses([
      (context) => {
        declared = getCurrentTools(context.messages).map((tool) => tool.name);
        return fauxAssistantMessage(
          [fauxToolCall("get_subagent_result", { agent_id: "child-session" })],
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage([fauxToolCall("script", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    await session.prompt("run the script");

    for (const name of CONTROL_TOOLS) assert.ok(declared.includes(name), `${name} should be declared`);
    const modelResult = session.agent.state.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "get_subagent_result",
    );
    assert.equal(modelResult?.isError, false);
    assert.equal(textOf(modelResult), "Subagent child-session completed.\n\nThe parser is in lib/parse.ts.");
    assert.deepEqual(outcomes, [
      { name: "echo", isError: false, text: "nested calls work" },
      { name: "Agent", isError: true, text: "Tool Agent not found" },
      { name: "get_subagent_result", isError: true, text: "Tool get_subagent_result not found" },
      { name: "steer_subagent", isError: true, text: "Tool steer_subagent not found" },
    ]);
    // Only the model's own call reached the runtime and consumed the terminal result.
    assert.deepEqual(calls, ["get:child-session", "markResultConsumed"]);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Agent resume rejects the remaining creation overrides before dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-resume-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const { calls, runtime } = recordingRuntime();
    const completed = await runtime.get("child-session");
    runtime.resume = async (request) => {
      calls.push(`resume:${request.sessionId}`);
      return { run: completed, completion: Promise.resolve(completed) };
    };
    session = await createSession(dir, faux, [createSubagentExtension(runtime, () => [])]);
    const params = { resume: "child-session", prompt: "Continue the task.", description: "Continue fixture" };
    const invoke = async (options) => {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("Agent", { ...params, ...options })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      await session.prompt("Continue the existing child.");
      return session.agent.state.messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === "Agent",
      );
    };

    // `model` is offered on a new subagent, so a resume call can carry it; it must still be rejected
    // rather than silently switching the model under the resumed session.
    for (const override of [
      { model: "different-provider/different-model" }, { input_files: ["fact.txt"] }, { isolation: "worktree" },
      { role: "review" }, { thinking: "high" },
    ]) {
      const rejected = await invoke(override);
      const name = Object.keys(override)[0];
      assert.equal(rejected?.isError, true, `${name} must not be silently ignored.`);
      assert.match(textOf(rejected), new RegExp(name));
      assert.deepEqual(calls, ["get:child-session"]);
    }

    // Empty defaults stay compatible, and so do the keys the tool no longer offers: a call written
    // against the old schema still validates, and the resumed child keeps its own settings.
    const result = await invoke({
      model: "", input_files: [], isolation: "", role: "", thinking: "", run_in_background: false,
      max_turns: 8, inherit_context: true,
    });
    assert.equal(result?.isError, false);
    assert.match(textOf(result), /Subagent child-session completed/);
    assert.deepEqual(calls, ["get:child-session", "resume:child-session"]);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Agent exposes only the parameters the model can choose correctly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-schema-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const { runtime } = recordingRuntime();
    session = await createSession(dir, faux, [createSubagentExtension(runtime, () => [])]);
    const agent = session.getAllTools().find((tool) => tool.name === "Agent");
    assert.deepEqual(Object.keys(agent.parameters.properties).sort(), [
      "description", "input_files", "isolation", "model", "prompt", "repo", "resume", "role", "run_in_background", "subagent_type", "thinking", "ticket", "wait_timeout",
    ]);
    const resultTool = session.getAllTools().find((tool) => tool.name === "get_subagent_result");
    for (const tool of [agent, resultTool]) {
      assert.equal(tool.parameters.properties.wait_timeout.type, "integer");
      assert.equal(tool.parameters.properties.wait_timeout.minimum, 1);
      assert.ok(!tool.parameters.required.includes("wait_timeout"));
    }
    // The profile owns these; a model that guessed one used to win over the configured value.
    for (const removed of ["max_turns", "inherit_context"]) {
      assert.equal(agent.parameters.properties[removed], undefined, `${removed} must not be offered.`);
    }
    // A string, not a "worktree" literal: a model that fills every optional field with "" must still
    // be able to start a subagent.
    assert.equal(agent.parameters.properties.isolation.type, "string");
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

// The scope is the session's, and pi can change it while the session runs (a new default model
// joins it), so the declaration each request carries must follow it.
test("Agent's model declaration lists the session's scoped models in every request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-scope-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }, { id: "pinned" }, { id: "later" }] });
    const { runtime } = recordingRuntime();
    session = await createSession(dir, faux, [createSubagentExtension(runtime, () => [])], (models) => [
      { model: models.getModel("faux-model") }, { model: models.getModel("pinned"), thinkingLevel: "high" },
    ]);
    const declaredModel = async () => {
      let description;
      faux.setResponses([(context) => {
        description = getCurrentTools(context.messages).find((tool) => tool.name === "Agent")
          ?.parameters.properties.model.description;
        return fauxAssistantMessage([fauxText("done")]);
      }]);
      await session.prompt("Which models may a subagent use?");
      return description;
    };
    const listed = (description) => /one of: (.*?)\. Any other model is refused\./.exec(description)?.[1];

    assert.equal(listed(await declaredModel()), "faux/faux-model, faux/pinned:high");
    session.setScopedModels([...session.scopedModels, { model: faux.getModel("later") }]);
    assert.equal(listed(await declaredModel()), "faux/faux-model, faux/pinned:high, faux/later");
    session.setScopedModels([]);
    assert.match(await declaredModel(), /^Optional provider\/modelId override\./);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

const SCOUT_PROFILE = {
  name: "scout-agent", displayName: "scout-agent", description: "The only subagent type", systemPrompt: "Delegate",
  tools: ["read"], roles: { kind: "loaded", path: "roles.json", roles: [
    { name: "worker", model: "faux/faux-model:medium", reading: [] },
    { name: "review", model: "faux/reviewer:high", reading: [] },
    // Its own model, not `pinned` at `high`: the declaration resolves it as the runtime does.
    { name: "stray", model: "faux/pinned:high", reading: [] },
  ] },
  inheritContext: false, runInBackground: true, enabled: true, scope: "package",
};

// The coordinator should not learn only at call time that a role's model is refused.
test("Agent's declaration marks a role whose model the session's scope refuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-role-scope-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }, { id: "reviewer" }, { id: "pinned" }, { id: "pinned:high" }] });
    const { runtime } = recordingRuntime();
    session = await createSession(dir, faux, [createSubagentExtension(runtime, () => [SCOUT_PROFILE])], (models) => [
      { model: models.getModel("faux-model") }, { model: models.getModel("pinned") },
    ]);
    const declaredRoles = async () => {
      let description;
      faux.setResponses([(context) => {
        description = getCurrentTools(context.messages).find((tool) => tool.name === "Agent")?.description;
        return fauxAssistantMessage([fauxText("done")]);
      }]);
      await session.prompt("Which roles may a subagent take?");
      return /Roles: (.*)\)$/m.exec(description)?.[1];
    };

    assert.equal(await declaredRoles(),
      "worker (faux/faux-model:medium), review (faux/reviewer:high, outside enabledModels), stray (faux/pinned:high, outside enabledModels)");
    session.setScopedModels([...session.scopedModels, { model: faux.getModel("reviewer") }]);
    assert.equal(await declaredRoles(),
      "worker (faux/faux-model:medium), review (faux/reviewer:high), stray (faux/pinned:high, outside enabledModels)");
    session.setScopedModels([]);
    assert.equal(await declaredRoles(), "worker (faux/faux-model:medium), review (faux/reviewer:high), stray (faux/pinned:high)");
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

// `role` is declared even where no profile has roles, so pi's validator types it: before, a number
// passed the validator as an undeclared key and crashed the tool on `.trim()`.
test("Agent's role is declared on every session, so pi validates its type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-role-type-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const { calls, runtime } = recordingRuntime();
    const roles = [];
    runtime.start = async (request) => {
      roles.push(request.role);
      throw new Error(`Unknown role ${request.role}`);
    };
    session = await createSession(dir, faux, [createSubagentExtension(runtime, () => [])]);
    const invoke = async (role) => {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("Agent", { prompt: "Inspect", description: "Typed role", role })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      await session.prompt("Start a subagent.");
      return session.agent.state.messages.findLast((message) => message.role === "toolResult" && message.toolName === "Agent");
    };

    const shaped = await invoke({ name: "review" });
    assert.equal(shaped.isError, true);
    assert.match(textOf(shaped), /^Validation failed for tool "Agent":\n {2}- role: /);
    assert.deepEqual(roles, []);
    // pi's validator coerces a number to the declared string, so the tool reads "5", never 5.
    const numbered = await invoke(5);
    assert.equal(textOf(numbered), "Unknown role 5");
    assert.deepEqual(roles, ["5"]);
    assert.deepEqual(calls, []);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a session with the subagent feature switched off registers no control tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-disabled-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const { runtime } = recordingRuntime();
    session = await createSession(dir, faux, [createSubagentExtension(runtime, () => [], () => false)]);

    const names = session.getAllTools().map((tool) => tool.name);
    for (const name of CONTROL_TOOLS) assert.ok(!names.includes(name), `${name} should not be registered`);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
