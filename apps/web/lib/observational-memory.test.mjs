import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const { buildMemorySnapshot, sessionLedgerPath } = await createJiti(import.meta.url).import("./observational-memory.ts");

function observation(id, content) {
  return { id, content, timestamp: "2026-11-09 10:00", relevance: "high", sourceEntryIds: ["u1"], tokenCount: 10 };
}

test("the memory snapshot counts a branch's ledger as /om:status does, with the live status and warnings", { skip: !existsSync(sessionLedgerPath()) && "no pi fork checkout" }, async () => {
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
  const snapshot = await buildMemorySnapshot({
    sessionId: "s1",
    entries,
    live: {
      getExtensionStatus: (key) => key === "observational-memory" ? "\u001b[2mcompact 12% · 0×\u001b[22m" : undefined,
      getRecentNotices: () => [
        { at: "2026-11-09T10:03:00.000Z", message: "Observational memory: observer failed: boom" },
        { at: "2026-11-09T10:04:00.000Z", message: "unrelated" },
      ],
    },
  });

  assert.equal(snapshot.status, "compact 12% · 0×");
  assert.equal(snapshot.observationLine, "Observations: 2 recorded / 1 dropped / 1 active / 0 visible +1");
  assert.equal(snapshot.reflectionLine, "Reflections:  0 recorded / 0 visible");
  assert.deepEqual(snapshot.observer, { at: "2026-11-09T10:01:00.000Z", recorded: 2 });
  assert.deepEqual(snapshot.reflector, { at: "2026-11-09T10:02:00.000Z", recorded: 0, dropped: 1 });
  assert.deepEqual(snapshot.errors, [{ at: "2026-11-09T10:03:00.000Z", message: "observer failed: boom" }]);
  assert.match(snapshot.recordedMemoryText, /\[bbbbbbbbbbbb\] 2026-11-09 10:00 \[high\] second/);
});
