import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getProjectTrustStatus,
  projectTrustReloadOptions,
  trustProject,
} = await jiti.import("./project-trust.ts");

async function createProjectFixture(t) {
  // Real paths: trust.json keys folders by them, and the temp folder is a link on macOS.
  const root = realpathSync(await mkdtemp(join(tmpdir(), "pi-web-project-trust-")));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd, agentDir };
}

test("clean projects stay on the normal trusted load path", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), {
    requiresTrust: false,
    trusted: true,
    decision: null,
    inherited: false,
  });
  assert.equal(projectTrustReloadOptions(cwd, agentDir), undefined);
});

test("project extensions execute only after the project is trusted", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  const extensionDir = join(cwd, ".pi", "extensions");
  const marker = join(root, "extension-executed");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "probe.js"),
    `import { writeFileSync } from "node:fs";\nexport default () => { writeFileSync(${JSON.stringify(marker)}, "executed"); };\n`,
  );

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), {
    requiresTrust: true,
    trusted: false,
    decision: null,
    inherited: false,
  });

  const restrictedLoader = new DefaultResourceLoader({ cwd, agentDir });
  await restrictedLoader.reload(projectTrustReloadOptions(cwd, agentDir));
  assert.equal(existsSync(marker), false);
  assert.equal(restrictedLoader.getExtensions().extensions.length, 0);

  assert.deepEqual(trustProject(cwd, agentDir), {
    requiresTrust: true,
    trusted: true,
    decision: true,
    decisionPath: cwd,
    inherited: false,
  });

  const trustedLoader = new DefaultResourceLoader({ cwd, agentDir });
  await trustedLoader.reload(projectTrustReloadOptions(cwd, agentDir));
  assert.equal(existsSync(marker), true);
  assert.equal(trustedLoader.getExtensions().extensions.length, 1);
});

test("trusting reports the decision it wrote, so a failed read afterwards cannot fail it", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "settings.json"), "{}");
  const link = join(root, "linked-project");
  await symlink(cwd, link);

  // Every read after the one that checks the folder fails, as a lock held
  // past the store's wait would; the write itself still succeeds.
  const getEntry = ProjectTrustStore.prototype.getEntry;
  let reads = 0;
  ProjectTrustStore.prototype.getEntry = function (...args) {
    reads += 1;
    if (reads > 1) throw new Error("Lock file is already being held");
    return getEntry.apply(this, args);
  };
  t.after(() => {
    ProjectTrustStore.prototype.getEntry = getEntry;
  });
  assert.deepEqual(
    trustProject(link, agentDir),
    { requiresTrust: true, trusted: true, decision: true, decisionPath: cwd, inherited: false },
    "keyed by the real path, as the store writes it",
  );
  assert.equal(reads, 1, "the status was read once, before the write");
  ProjectTrustStore.prototype.getEntry = getEntry;
  assert.equal(new ProjectTrustStore(agentDir).get(cwd), true);
});

test("the reload resolver reads the latest persisted trust decision", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });

  const reloadOptions = projectTrustReloadOptions(cwd, agentDir);
  assert.ok(reloadOptions);
  assert.equal(await reloadOptions.resolveProjectTrust(), false);

  trustProject(cwd, agentDir);
  assert.equal(await reloadOptions.resolveProjectTrust(), true);
});

test("the status tells exact, inherited, refused and missing decisions apart", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  const store = new ProjectTrustStore(agentDir);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "settings.json"), "{}");
  const status = () => getProjectTrustStatus(cwd, agentDir);

  assert.deepEqual(status(), { requiresTrust: true, trusted: false, decision: null, inherited: false });
  store.set(cwd, true);
  assert.deepEqual(status(), { requiresTrust: true, trusted: true, decision: true, decisionPath: cwd, inherited: false });
  store.set(cwd, false);
  assert.deepEqual(status(), { requiresTrust: true, trusted: false, decision: false, decisionPath: cwd, inherited: false });
  store.set(cwd, null);
  store.set(root, true);
  assert.deepEqual(status(), { requiresTrust: true, trusted: true, decision: true, decisionPath: root, inherited: true });
  store.set(root, false);
  assert.deepEqual(status(), { requiresTrust: true, trusted: false, decision: false, decisionPath: root, inherited: true });
  store.set(root, true);
  store.set(cwd, false);
  assert.deepEqual(
    status(),
    { requiresTrust: true, trusted: false, decision: false, decisionPath: cwd, inherited: false },
    "an exact false beneath a trusted parent",
  );
});

test("a folder that requires no trust still reports the decision it would inherit", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  const store = new ProjectTrustStore(agentDir);
  store.set(root, true);
  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), {
    requiresTrust: false,
    trusted: true,
    decision: true,
    decisionPath: root,
    inherited: true,
  });
  store.set(root, false);
  assert.equal(getProjectTrustStatus(cwd, agentDir).decision, false);
  assert.equal(getProjectTrustStatus(cwd, agentDir).trusted, false, "a saved false wins although nothing needs trust, as in pi 1.5");
  store.set(root, null);
  assert.equal(getProjectTrustStatus(cwd, agentDir).trusted, true, "no decision: nothing needs trust");
});

test("a folder opened through a link is trusted exactly, as trust.json keys it by its real path", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  const link = join(root, "linked-project");
  await symlink(cwd, link);
  new ProjectTrustStore(agentDir).set(link, true);
  assert.deepEqual(getProjectTrustStatus(link, agentDir), {
    requiresTrust: true,
    trusted: true,
    decision: true,
    decisionPath: cwd,
    inherited: false,
  });
});

test("an unreadable trust store does not fail a folder that requires no trust", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await writeFile(join(agentDir, "trust.json"), "{ not json");
  const status = getProjectTrustStatus(cwd, agentDir);
  assert.equal(status.requiresTrust, false);
  assert.equal(status.trusted, true);
  assert.equal(status.decision, null);
  assert.match(status.decisionError, /trust\.json/);
  assert.equal(projectTrustReloadOptions(cwd, agentDir), undefined, "session start never reads the store for it");
});

test("all project resource loaders and reloads enforce project trust", async () => {
  const rpcSource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const modelsSource = await readFile(new URL("../app/api/models/route.ts", import.meta.url), "utf8");
  const skillsSource = await readFile(new URL("./skills-service.ts", import.meta.url), "utf8");
  const skillsInstallSource = await readFile(new URL("../app/api/skills/install/route.ts", import.meta.url), "utf8");
  const pluginsSource = await readFile(new URL("../app/api/plugins/route.ts", import.meta.url), "utf8");
  const enabledModelsSource = await readFile(new URL("../app/api/models/enabled/route.ts", import.meta.url), "utf8");
  const enabledModelsRuntimeSource = await readFile(new URL("./enabled-models-runtime.ts", import.meta.url), "utf8");

  assert.match(rpcSource, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(rpcSource, /projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(rpcSource, /resourceLoaderReloadOptions: trustReloadOptions/);
  assert.equal(
    Array.from(rpcSource.matchAll(/this\.syncProjectTrust\(\);\s*await this\.inner\.reload/g)).length,
    2,
  );

  assert.match(modelsSource, /projectTrustReloadOptions\(cwd, agentDir\)/);
  assert.match(modelsSource, /resourceLoaderReloadOptions: trustReloadOptions/);
  assert.match(skillsSource, /loader\.reload\(projectTrustReloadOptions\(cwd, agentDir\)\)/);
  assert.match(pluginsSource, /projectTrusted: projectTrust\.trusted/);
  assert.match(
    skillsInstallSource,
    /getProjectTrustStatus\(cwd, getAgentDir\(\)\)\.trusted/,
  );
  assert.equal(
    Array.from(pluginsSource.matchAll(/projectTrusted: projectTrust\.trusted/g)).length,
    2,
  );
  assert.match(pluginsSource, /scope === "project" && !projectTrust\.trusted/);
  assert.match(enabledModelsSource, /createEnabledModelsSettingsManager\(cwd, agentDir\)/);
  assert.doesNotMatch(enabledModelsSource, /SettingsManager\.create\(/);
  assert.match(enabledModelsRuntimeSource, /projectTrusted: getProjectTrustStatus\(cwd, agentDir\)\.trusted/);
});
