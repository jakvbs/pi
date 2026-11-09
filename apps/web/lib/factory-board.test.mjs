import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { readBoardLanes, boardSpecDir, BOARD_DONE_SHOWN } = await createJiti(import.meta.url).import("./factory-board.ts");

function ticket(dir, number, fields) {
  mkdirSync(dir, { recursive: true });
  const front = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n");
  writeFileSync(join(dir, "ticket.md"), `---\n${front}\n---\n\n# F${number} · ticket ${number}\n`);
}

test("the board lists every active and planned folder and the latest done ones by landing date", () => {
  const spec = mkdtempSync(join(tmpdir(), "board-"));
  const features = join(spec, "features");
  ticket(join(features, "active", "F046-board"), "046", { repo: "agegr-pi-web", opened: "2026-11-09" });
  mkdirSync(join(features, "active", "F050-no-ticket-file"), { recursive: true });
  ticket(join(features, "planned", "F047-next"), "047", { repo: "legible", opened: "2026-11-09" });
  for (let n = 1; n <= 12; n += 1) {
    const number = String(n).padStart(3, "0");
    const landed = n <= 2 ? "2026-11-09" : `2026-10-${String(n + 10).padStart(2, "0")}`;
    ticket(join(features, "done", landed.slice(0, 7), `F${number}-done`), number, { repo: "legible", opened: "2026-10-01", landed });
  }

  const lanes = readBoardLanes(spec);
  assert.deepEqual(lanes.active.map((t) => [t.id, t.title, t.repo ?? null]), [["F046", "ticket 046", "agegr-pi-web"], ["F050", "F050-no-ticket-file", null]]);
  assert.deepEqual(lanes.planned.map((t) => t.folder), ["F047-next"]);
  assert.equal(lanes.done.length, BOARD_DONE_SHOWN);
  assert.deepEqual(lanes.done.slice(0, 3).map((t) => t.id), ["F002", "F001", "F012"]);
  assert.equal(lanes.done.at(-1).id, "F005");
});

test("PI_WEB_SPEC_DIR names the spec directory", () => {
  assert.equal(boardSpecDir({ PI_WEB_SPEC_DIR: "/tmp/spec" }), "/tmp/spec");
  assert.match(boardSpecDir({}), /\.repos\/legible\/spec$/);
});
