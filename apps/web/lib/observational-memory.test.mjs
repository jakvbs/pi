import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildMemorySnapshot, memoryStatusPath, MEMORY_STATUS_EVENT, sessionLedgerPath, watchMemoryStatus } = await jiti.import("./observational-memory.ts");
const noFork = !existsSync(sessionLedgerPath()) || !existsSync(memoryStatusPath()) ? "no pi fork checkout" : false;

function observation(id, content) {
  return { id, content, timestamp: "2026-11-09 10:00", relevance: "high", sourceEntryIds: ["u1"], tokenCount: 10 };
}

const entries = [
  { type: "message", id: "u1", timestamp: "2026-11-09T10:00:00.000Z", message: { role: "user", content: "hi" } },
  {
    type: "custom", id: "o1", timestamp: "2026-11-09T10:01:00.000Z", customType: "om.observations.recorded",
    data: { observations: [observation("aaaaaaaaaaaa", "first"), observation("bbbbbbbbbbbb", "second")], coversUpToId: "u1" },
  },
  {
    type: "custom", id: "r1", timestamp: "2026-11-09T10:02:00.000Z", customType: "om.observations.dropped",
    data: { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "u1" },
  },
];

const published = {
  passive: false,
  memory: ["Observations: 9 recorded / 0 dropped / 9 active / 9 visible", "Reflections:  0 recorded / 0 visible"],
  activity: ["Next observation: ~120 / 10,000 tokens (1%)"],
  inFlight: [],
  errors: { observer: "observer failed: 400 Bad Request" },
};

test("a session read from its file counts its branch with the extension's own /om:status function", { skip: noFork }, async () => {
  const snapshot = await buildMemorySnapshot({ sessionId: "s1", entries });

  assert.equal(snapshot.live, false);
  assert.equal(snapshot.omStatus, undefined);
  assert.deepEqual(snapshot.memoryLines, ["Observations: 2 recorded / 1 dropped / 1 active / 0 visible +1", "Reflections:  0 recorded / 0 visible"]);
  assert.deepEqual(snapshot.observer, { at: "2026-11-09T10:01:00.000Z", recorded: 2 });
  assert.deepEqual(snapshot.reflector, { at: "2026-11-09T10:02:00.000Z", recorded: 0, dropped: 1 });
  assert.match(snapshot.recordedMemoryText, /\[bbbbbbbbbbbb\] 2026-11-09 10:00 \[high\] second/);
});

test("a running session shows the status observational memory published, with its stage error", { skip: noFork }, async () => {
  const bus = createEventBus();
  const watch = watchMemoryStatus(bus);
  bus.emit(MEMORY_STATUS_EVENT, published);
  // Another shape (an extension of another version) leaves the last good status.
  bus.emit(MEMORY_STATUS_EVENT, { passive: false, memory: "not lines" });

  const snapshot = await buildMemorySnapshot({
    sessionId: "s1",
    entries,
    live: {
      getExtensionStatus: (key) => key === "observational-memory" ? "\u001b[2mcompact 12% · 0×\u001b[22m" : undefined,
      getMemoryStatus: () => watch.latest(),
    },
  });

  assert.equal(snapshot.status, "compact 12% · 0×");
  assert.deepEqual(snapshot.omStatus, published);
  assert.deepEqual(snapshot.memoryLines, published.memory);
});

test("the status the extension publishes reaches the panel as the text /om:status prints", { skip: noFork }, async () => {
  const { registerMemoryStatusEvents, renderMemoryStatus } = await jiti.import(memoryStatusPath());
  const { Runtime } = await jiti.import(memoryStatusPath().replace(/memory-status\.ts$/, "runtime.ts"));
  const bus = createEventBus();
  const watch = watchMemoryStatus(bus);
  const handlers = new Map();
  const runtime = new Runtime();
  runtime.configLoaded = true;
  runtime.lastObserverError = "observer failed: boom";
  registerMemoryStatusEvents({ on: (name, handler) => handlers.set(name, handler), events: bus }, runtime);

  handlers.get("turn_end")({ entries: [] }, {
    cwd: "/tmp",
    sessionManager: { getBranch: () => entries },
    model: undefined,
    getContextUsage: () => undefined,
  });

  const status = watch.latest();
  assert.ok(status);
  assert.deepEqual(status.errors, { observer: "observer failed: boom" });
  assert.match(renderMemoryStatus(status), /── Last error ──\nObserver: observer failed: boom/);
  assert.equal(status.memory[0], "Observations: 2 recorded / 1 dropped / 1 active / 0 visible +1");
});
