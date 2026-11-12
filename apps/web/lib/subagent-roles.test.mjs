import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { findSubagentRole, readSubagentRoles, subagentRolesText } = await createJiti(import.meta.url).import("./subagent-roles.ts");
const { PROJECT_SETTINGS_MAX_BYTES } = await createJiti(import.meta.url).import("./regular-file.ts");

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
    await invalid(JSON.stringify({ worker: { model: "x/y", reading: [""] } }), /role worker needs/);
    await invalid(JSON.stringify({ worker: "x/y" }), /role worker needs/);
  });
});

test("invalid JSON in a roles file never quotes any of the file's content", async () => {
  await withDir(async (dir) => {
    const profile = join(dir, "scout-agent.md");
    for (const secret of [
      "'ghp_short_secret'",
      '{\n  "worker": \'ghp_long_secret_token_value_12345\'\n}',
      "ghp_bare_secret_token",
    ]) {
      await writeFile(join(dir, "roles.json"), secret);
      const roles = readSubagentRoles("roles.json", profile);
      assert.equal(roles.kind, "invalid", secret);
      assert.match(roles.error, /^cannot read roles file roles\.json: /);
      assert.doesNotMatch(roles.error, /ghp_|secret|worker/, secret);
      assert.doesNotMatch(subagentRolesText(roles, () => true), /ghp_|secret|worker/, secret);
      assert.throws(
        () => findSubagentRole("scout-agent", roles, "worker"),
        (error) => !/ghp_|secret/.test(error.message),
      );
    }
  });
});

test("roles file reading refuses non-regular and oversized files without blocking", async () => {
  await withDir(async (dir) => {
    const profile = join(dir, "scout-agent.md");
    await mkdir(join(dir, "folder"));
    assert.match(readSubagentRoles("folder", profile).error, /not a regular file/);

    await writeFile(join(dir, "huge.json"), " ".repeat(PROJECT_SETTINGS_MAX_BYTES + 1));
    assert.match(readSubagentRoles("huge.json", profile).error, /larger than/);

    if (process.platform !== "win32") {
      const fifo = join(dir, "roles.fifo");
      execFileSync("mkfifo", [fifo]);
      assert.match(readSubagentRoles("roles.fifo", profile).error, /not a regular file/);
    }
  });
});

test("a role with a malformed model reference is reported when the roles load", async () => {
  await withDir(async (dir) => {
    const profile = join(dir, "scout-agent.md");
    for (const model of [
      "claude-opus-5-5",
      "claude-opus-5-5:high",
      "/claude-opus-5-5",
      "pi-sub-anthropic/",
      "pi-sub-anthropic/:high",
      "pi-sub-anthropic/claude-opus-5-5:",
      "pi-sub-anthropic/claude-opus-5-5:turbo",
      "pi-sub-anthropic/claude opus:high",
      "pi-sub-anthropic:extra/claude-opus-5-5",
      "pi-sub-anthropic//claude-opus-5-5",
    ]) {
      await writeFile(join(dir, "roles.json"), JSON.stringify({ worker: { model, reading: [] } }));
      const roles = readSubagentRoles("roles.json", profile);
      assert.equal(roles.kind, "invalid", model);
      assert.match(roles.error, /role worker .*model/i, model);
    }
    for (const model of [
      "pi-sub-anthropic/claude-opus-5-5:medium",
      "x/y",
      "openrouter/anthropic/claude-sonnet-4:high",
      "ollama/qwen3:8b:low",
    ]) {
      await writeFile(join(dir, "roles.json"), JSON.stringify({ worker: { model, reading: [] } }));
      assert.equal(readSubagentRoles("roles.json", profile).kind, "loaded", model);
    }
  });
});

test("a role is found by name, and refused with the list of roles otherwise", () => {
  const roles = { kind: "loaded", path: "roles.json", roles: [{ name: "worker", ...ROLES.worker }, { name: "judge", ...ROLES.judge }] };
  assert.equal(findSubagentRole("scout-agent", roles, "judge").model, ROLES.judge.model);
  assert.throws(() => findSubagentRole("scout-agent", roles, "Judge"), { message: "Unknown role Judge for subagent scout-agent. Roles: worker, judge." });
  assert.throws(() => findSubagentRole("explore", undefined, "judge"), { message: "Subagent profile explore has no roles; omit role." });
  assert.throws(() => findSubagentRole("scout-agent", { kind: "invalid", path: "r.json", error: "boom" }, "judge"),
    { message: "Subagent profile scout-agent has no usable roles: boom" });
  assert.equal(
    subagentRolesText(roles, () => true),
    "Roles: worker (pi-sub-anthropic/claude-opus-5-5:medium, reading: ~/.repos/legible/skills/scout-mode/SKILL.md), judge (pi-sub-anthropic/claude-fable-5-2:high, reading: a.md, b.md)",
  );
  assert.equal(
    subagentRolesText(roles, (model) => model.startsWith("pi-sub-anthropic/claude-opus")),
    "Roles: worker (pi-sub-anthropic/claude-opus-5-5:medium, reading: ~/.repos/legible/skills/scout-mode/SKILL.md), judge (pi-sub-anthropic/claude-fable-5-2:high, outside enabledModels, reading: a.md, b.md)",
  );
});
