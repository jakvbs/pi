import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// The hook, the store it is built on (useStoredChoice.ts, tested with
// useFilesPlacement) and the policy's defaults, run in a sandbox whose only
// other import is React.
const compile = (file) => new Script(`(function (exports, require) {\n${ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText}\n})`);
const scripts = {
  hook: compile("./useCollapsePolicy.ts"),
  "./useStoredChoice": compile("./useStoredChoice.ts"),
  "@/lib/collapse-policy": compile("../lib/collapse-policy.ts"),
};

function fixture(initial = {}) {
  const stored = new Map(Object.entries(initial));
  const context = createContext({
    window: {
      localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const react = { useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot() };
  const run = (script) => {
    const moduleExports = {};
    script.runInContext(context)(moduleExports, (id) => (id === "react" ? react : run(scripts[id])));
    return moduleExports;
  };
  return { ...run(scripts.hook), stored };
}

test("each block type is saved and restored on its own; anything else reads as its default", () => {
  const store = fixture({ "pi-web:collapse-policy:toolCalls": "expanded", "pi-web:collapse-policy:thinking": "open" });
  assert.deepEqual({ ...store.useCollapsePolicy() }, {
    toolCalls: "expanded",
    subagents: "collapsed",
    extensionMessages: "expanded",
    thinking: "collapsed",
  });
  store.setBlockStart("subagents", "expanded");
  assert.equal(store.stored.get("pi-web:collapse-policy:subagents"), "expanded");
  assert.equal(store.useCollapsePolicy().subagents, "expanded");
  assert.equal(store.useCollapsePolicy().toolCalls, "expanded");
});
