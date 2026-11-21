import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getLastSettingsSection,
  getLastSettingsSelection,
  settingsSectionRequiresProject,
  SETTINGS_SECTION_VALUES,
  setLastSettingsSection,
  setLastSettingsSelection,
} = await jiti.import("./settings-navigation.ts");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("restores the last settings section and falls back without a project", () => {
  const storage = createStorage();

  setLastSettingsSection("models", storage);
  assert.equal(getLastSettingsSection(null, storage), "models");

  setLastSettingsSection("skills", storage);
  assert.equal(getLastSettingsSection("/project", storage), "skills");
  assert.equal(getLastSettingsSection(null, storage), "general");

  setLastSettingsSection("agents", storage);
  assert.equal(getLastSettingsSection("/project", storage), "agents");
});

test("keeps project settings selections isolated by cwd", () => {
  const storage = createStorage();

  setLastSettingsSelection("skills", "/one/skill.md", "/project-one", storage);
  setLastSettingsSelection("skills", "/two/skill.md", "/project-two", storage);

  assert.equal(getLastSettingsSelection("skills", "/project-one", storage), "/one/skill.md");
  assert.equal(getLastSettingsSelection("skills", "/project-two", storage), "/two/skill.md");
  assert.equal(getLastSettingsSelection("skills", "/project-three", storage), null);
});

test("shares the models selection globally", () => {
  const storage = createStorage();
  const selection = JSON.stringify({ type: "provider", name: "custom" });

  setLastSettingsSelection("models", selection, "/project-one", storage);

  assert.equal(getLastSettingsSelection("models", "/project-two", storage), selection);
  assert.equal(getLastSettingsSelection("models", null, storage), selection);
});

test("only the project sections need a project", () => {
  assert.equal(settingsSectionRequiresProject("models"), false);
  assert.equal(settingsSectionRequiresProject("general"), false);
  for (const section of ["skills", "agents", "plugins"]) {
    assert.equal(settingsSectionRequiresProject(section), true, section);
  }
  // Settings › MCP is gone: a stored "mcp" section is not one any more.
  assert.equal(SETTINGS_SECTION_VALUES.includes("mcp"), false);
});

test("a project section remembers nothing without a project", () => {
  const storage = createStorage();
  setLastSettingsSelection("plugins", "key", null, storage);
  assert.equal(getLastSettingsSelection("plugins", null, storage), null);
  setLastSettingsSelection("plugins", "key", "/project-one", storage);
  assert.equal(getLastSettingsSelection("plugins", "/project-one", storage), "key");
});

test("ignores malformed and unavailable browser storage", () => {
  const malformed = createStorage({ "pi-web:settings-navigation": "{" });
  const unavailable = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };

  assert.equal(getLastSettingsSection("/project", malformed), "general");
  assert.equal(getLastSettingsSelection("plugins", "/project", malformed), null);
  assert.equal(getLastSettingsSection("/project", unavailable), "general");
  assert.doesNotThrow(() => setLastSettingsSection("plugins", unavailable));
  assert.doesNotThrow(() => setLastSettingsSelection("plugins", "key", "/project", unavailable));
});
