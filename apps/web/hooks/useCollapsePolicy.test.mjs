import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

function compile(url) {
  return new Script(ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText);
}

const hookScript = compile(new URL("./useCollapsePolicy.ts", import.meta.url));
const policyScript = compile(new URL("../lib/collapse-policy.ts", import.meta.url));
const KEY = "pi-web:collapse-policy";
const LEGACY_KEY = "pi-thinking-expanded";

// A fresh module per fixture: the store caches the policy at module level. The
// stand-in useSyncExternalStore subscribes once, as a mounted block does.
function fixture({ initial = {}, blocked = false, server = false } = {}) {
  const stored = new Map(Object.entries(initial));
  const events = new Map();
  let unsubscribe = null;
  let notifications = 0;
  const storage = {
    getItem(key) { if (blocked) throw new Error("blocked"); return stored.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error("blocked"); stored.set(key, value); },
    removeItem(key) { if (blocked) throw new Error("blocked"); stored.delete(key); },
  };
  const policyExports = {};
  policyScript.runInNewContext({ exports: policyExports });
  const exports = {};
  hookScript.runInNewContext({
    exports,
    require(id) {
      if (id === "@/lib/collapse-policy") return policyExports;
      if (id !== "react") throw new Error(`Unexpected import ${id}`);
      return {
        useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
          if (server) return getServerSnapshot();
          unsubscribe ??= subscribe(() => notifications++);
          return getSnapshot();
        },
      };
    },
    ...(!server && {
      window: {
        localStorage: storage,
        addEventListener(type, listener) { events.set(type, listener); },
        removeEventListener(type) { events.delete(type); },
      },
    }),
  });
  return {
    ...exports,
    stored,
    events,
    get notifications() { return notifications; },
  };
}

test("the server renders the defaults without touching browser APIs", () => {
  const store = fixture({ server: true, initial: { [KEY]: JSON.stringify({ subagents: "expanded" }) } });
  assert.equal(store.useCollapsePolicy().subagents, "collapsed");
});

test("a saved policy is restored, and a change is saved whole and announced to mounted blocks", () => {
  const store = fixture({ initial: { [KEY]: JSON.stringify({ toolCalls: "expanded" }) } });
  assert.equal(store.useCollapsePolicy().toolCalls, "expanded");
  store.setBlockStart("subagents", "expanded");
  assert.equal(store.useCollapsePolicy().subagents, "expanded");
  assert.deepEqual(JSON.parse(store.stored.get(KEY)), {
    toolCalls: "expanded",
    subagents: "expanded",
    extensionMessages: "expanded",
    thinking: "collapsed",
    bash: "collapsed",
  });
  assert.equal(store.notifications, 1);
  store.setBlockStart("subagents", "expanded");
  assert.equal(store.notifications, 1, "the same choice again changes nothing");
});

test("the older thinking switch carries over until the first save, which drops it", () => {
  const store = fixture({ initial: { [LEGACY_KEY]: "true" } });
  assert.equal(store.useCollapsePolicy().thinking, "expanded");
  store.setBlockStart("bash", "expanded");
  assert.equal(JSON.parse(store.stored.get(KEY)).thinking, "expanded");
  assert.equal(store.stored.has(LEGACY_KEY), false);
});

test("another tab's policy is followed", () => {
  const store = fixture();
  assert.equal(store.useCollapsePolicy().subagents, "collapsed");
  store.stored.set(KEY, JSON.stringify({ subagents: "expanded" }));
  store.events.get("storage")({ key: "pi-other" });
  assert.equal(store.notifications, 0);
  store.events.get("storage")({ key: KEY });
  assert.equal(store.useCollapsePolicy().subagents, "expanded");
  assert.equal(store.notifications, 1);
});

test("a blocked storage keeps the defaults and still applies a choice for the page", () => {
  const store = fixture({ blocked: true });
  assert.equal(store.useCollapsePolicy().extensionMessages, "expanded");
  store.setBlockStart("extensionMessages", "collapsed");
  assert.equal(store.useCollapsePolicy().extensionMessages, "collapsed");
  assert.equal(store.notifications, 1);
});
