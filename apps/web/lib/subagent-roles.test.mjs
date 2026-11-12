import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { findSubagentRole, readSubagentRoles, subagentRolesText } = await createJiti(import.meta.url).import("./subagent-roles.ts");

async function withDir(check) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-roles-"));
  try {
    await check(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ROLES = {
  worker: { model: "pi-sub-anthropic/claude-opus-5-5:medium", reading: ["~/.repos/legible/skills/scout-mode/SKILL.md"] },
  judge: { model: "pi-sub-anthropic/claude-fable-5-2:high", reading: ["a.md", "b.md"] },
};

test("a profile's roles file is read relative to the profile, or from the home directory", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "roles.json"), JSON.stringify(ROLES));
    const profile = join(dir, "agents", "scout-agent.md");
    const expected = (path) => ({ kind: "loaded", path, roles: [
      { name: "worker", ...ROLES.worker }, { name: "judge", ...ROLES.judge },
    ] });
    assert.deepEqual(readSubagentRoles("../roles.json", profile), expected("../roles.json"));
    const fromHome = `~/${relative(homedir(), join(dir, "roles.json"))}`;
    assert.deepEqual(readSubagentRoles(fromHome, profile), expected(fromHome));
    assert.equal(readSubagentRoles(undefined, profile), undefined);
  });
});

test("a missing or malformed roles file is reported, not ignored", async () => {
  await withDir(async (dir) => {
    const profile = join(dir, "scout-agent.md");
    const invalid = async (content, error) => {
      await writeFile(join(dir, "roles.json"), content);
      const roles = readSubagentRoles("roles.json", profile);
      assert.equal(roles.kind, "invalid", content);
      assert.match(roles.error, error, content);
      assert.match(subagentRolesText(roles, () => true), /^Roles unavailable: /);
    };
    assert.match(readSubagentRoles("absent.json", profile).error, /^cannot read roles file absent\.json: ENOENT/);
    assert.equal(readSubagentRoles(["roles.json"], profile).error, "roles must be the path of a roles file");
    await invalid("{ not json", /^cannot read roles file roles\.json: /);
    await invalid("[]", /must be a JSON object of roles/);
    await invalid(JSON.stringify({ worker: { model: "x/y" } }), /role worker needs a model string and a reading list/);
    await invalid(JSON.stringify({ worker: { model: "", reading: [] } }), /role worker needs/);
    await invalid(JSON.stringify({ worker: { model: "x/y", reading: [1] } }), /role worker needs/);
    await invalid(JSON.stringify({ worker: "x/y" }), /role worker needs/);
  });
});

test("a role is found by name, and refused with the list of roles otherwise", () => {
  const roles = { kind: "loaded", path: "roles.json", roles: [{ name: "worker", ...ROLES.worker }, { name: "judge", ...ROLES.judge }] };
  assert.equal(findSubagentRole("scout-agent", roles, "judge").model, ROLES.judge.model);
  assert.throws(() => findSubagentRole("scout-agent", roles, "Judge"), { message: "Unknown role Judge for subagent scout-agent. Roles: worker, judge." });
  assert.throws(() => findSubagentRole("explore", undefined, "judge"), { message: "Subagent profile explore has no roles; omit role." });
  assert.throws(() => findSubagentRole("scout-agent", { kind: "invalid", path: "r.json", error: "boom" }, "judge"),
    { message: "Subagent profile scout-agent has no usable roles: boom" });
  assert.equal(subagentRolesText(roles, () => true), "Roles: worker (pi-sub-anthropic/claude-opus-5-5:medium), judge (pi-sub-anthropic/claude-fable-5-2:high)");
  assert.equal(subagentRolesText(roles, (model) => model.startsWith("pi-sub-anthropic/claude-opus")),
    "Roles: worker (pi-sub-anthropic/claude-opus-5-5:medium), judge (pi-sub-anthropic/claude-fable-5-2:high, outside enabledModels)");
});
