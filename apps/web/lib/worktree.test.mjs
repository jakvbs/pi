import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./worktree.ts");
}

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

test("main and linked worktrees share one canonical project root", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/test", linked]);

  const { findCurrentWorktreePath, listWorktrees, resolveProject } = await loadSubject();
  const mainProject = await resolveProject(`${repo}${path.sep}`);
  const linkedProject = await resolveProject(linked);

  assert.equal(mainProject.isTopLevel, true);
  assert.equal(mainProject.isWorktree, false);
  assert.equal(linkedProject.isTopLevel, true);
  assert.equal(linkedProject.isWorktree, true);
  assert.equal(linkedProject.branch, "feature/test");
  assert.equal(mainProject.projectRoot, linkedProject.projectRoot);

  const worktrees = await listWorktrees(linked);
  const listedLinked = worktrees.find((worktree) => worktree.branch === "feature/test");
  assert.ok(listedLinked);
  assert.equal(findCurrentWorktreePath(worktrees, `${linked}${path.sep}`), listedLinked.path);
});

test("a removed worktree resolves back to the repo it branched from", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-removed-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  await execFileAsync("git", ["init", repo]);

  const { inferRemovedWorktree } = await loadSubject();

  // addWorktree() places worktrees in `<repoRoot>-worktrees/<branch>`, and a finished
  // subagent run removes that directory while its session file still records it as the cwd.
  const removed = inferRemovedWorktree(path.join(`${repo}-worktrees`, "pi-web-agent-abc"));
  assert.equal(removed?.projectRoot, realpathSync(repo));

  // A cwd that is gone for any other reason has no repo to fall back to.
  assert.equal(inferRemovedWorktree(path.join(tempRoot, "not-a-worktree-dir")), null);
  assert.equal(inferRemovedWorktree(path.join(`${tempRoot}-worktrees`, "orphan")), null);
});

test("recognizes submodule and dirty-worktree removal errors as forceable", async () => {
  const { worktreeRemovalRequiresForce } = await loadSubject();

  assert.equal(worktreeRemovalRequiresForce("fatal: working trees containing submodules cannot be moved or removed"), true);
  assert.equal(worktreeRemovalRequiresForce("fatal: '/tmp/linked' contains modified or untracked files, use --force to delete it"), true);
  assert.equal(worktreeRemovalRequiresForce("fatal: worktree is dirty"), true);
  // A locked worktree needs `remove -f -f`; a single force would still fail.
  assert.equal(worktreeRemovalRequiresForce("fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first"), false);
  assert.equal(worktreeRemovalRequiresForce("fatal: unrelated git failure"), false);
});

test("tells files a worktree still holds from submodules it contains", async () => {
  const { worktreeHasUncommittedFiles } = await loadSubject();

  assert.equal(worktreeHasUncommittedFiles("fatal: '/tmp/linked' contains modified or untracked files, use --force to delete it"), true);
  assert.equal(worktreeHasUncommittedFiles("fatal: worktree is dirty"), true);
  assert.equal(worktreeHasUncommittedFiles("fatal: working trees containing submodules cannot be moved or removed"), false);
  assert.equal(worktreeHasUncommittedFiles("fatal: unrelated git failure"), false);
});

test("forced worktree removal passes Git's force flag", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-force-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/force", linked]);
  await writeFile(path.join(linked, "untracked.txt"), "discard me\n");

  const { removeWorktree } = await loadSubject();
  await removeWorktree(repo, linked, true);
  assert.equal(existsSync(linked), false);
});

test("worktree removal accepts a path that runs through a link", async (t) => {
  // Git lists worktrees by their real path; macOS's tmpdir is a link to /private/var.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-link-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const alias = path.join(tempRoot, "alias");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/link", path.join(tempRoot, "linked")]);
  await symlink(tempRoot, alias, "dir");

  const { removeWorktree } = await loadSubject();
  await removeWorktree(repo, path.join(alias, "linked"));
  assert.equal(existsSync(path.join(tempRoot, "linked")), false);
});

test("worktrees of bare clones group under their clone, not the folder holding them (#1049)", async (t) => {
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-bare-")));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const source = path.join(tempRoot, "source");
  await execFileAsync("git", ["init", source]);
  await git(source, ["config", "user.name", "Pi Web Test"]);
  await git(source, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(source, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(source, "README.md"), "# test\n");
  await git(source, ["add", "README.md"]);
  await git(source, ["commit", "-m", "initial"]);

  // parent/repo1.git/worktree1 and parent/repo2.git/worktree1
  const parent = path.join(tempRoot, "parent");
  for (const name of ["repo1.git", "repo2.git"]) {
    await git(tempRoot, ["clone", "--bare", source, path.join(parent, name)]);
    await git(path.join(parent, name), ["worktree", "add", "-b", "worktree1", path.join(parent, name, "worktree1")]);
  }
  // The `.bare` layout: project/.git is a file pointing at project/.bare.
  const project = path.join(tempRoot, "project");
  await git(tempRoot, ["clone", "--bare", source, path.join(project, ".bare")]);
  await writeFile(path.join(project, ".git"), "gitdir: ./.bare\n");
  await git(project, ["worktree", "add", "-b", "feature", path.join(project, "feature")]);

  const { addWorktree, invalidateProjectCache, resolveProject } = await loadSubject();
  for (const name of ["repo1.git", "repo2.git"]) {
    const clone = path.join(parent, name);
    const linked = await resolveProject(path.join(clone, "worktree1"));
    assert.equal(linked.isWorktree, true);
    assert.equal(linked.projectRoot, clone);
    assert.equal((await resolveProject(clone)).projectRoot, clone);
  }
  assert.equal((await resolveProject(path.join(project, "feature"))).projectRoot, project);

  // A new worktree goes to that clone, beside it.
  const created = await addWorktree(path.join(parent, "repo1.git"), "created");
  assert.equal(created.path, path.join(parent, "repo1.git-worktrees", "created"));
  assert.equal((await resolveProject(created.path)).projectRoot, path.join(parent, "repo1.git"));

  // Its sessions stay in that project once the folder is gone.
  await rm(created.path, { recursive: true, force: true });
  invalidateProjectCache();
  assert.equal((await resolveProject(created.path)).projectRoot, path.join(parent, "repo1.git"));
});

async function linkedWorktree(t, prefix) {
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/phantom", linked]);
  return { tempRoot, repo, linked };
}

/** Runs `fn` with a `git` on PATH that is killed before it answers. */
async function withKilledGit(t, tempRoot, fn) {
  const bin = path.join(tempRoot, "killed-bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "git"), "#!/bin/sh\nkill -9 $$\n");
  await chmod(path.join(bin, "git"), 0o755);
  t.mock.method(console, "error", () => {});
  const savedPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    return await fn();
  } finally {
    process.env.PATH = savedPath;
  }
}

test("a killed git is not cached as the worktree's project (phantom project)", { skip: process.platform === "win32" }, async (t) => {
  const { tempRoot, repo, linked } = await linkedWorktree(t, "pi-web-worktree-killed-");
  const { resolveProject } = await loadSubject();

  const degraded = await withKilledGit(t, tempRoot, () => resolveProject(linked));
  assert.equal(degraded.projectRoot, linked);
  assert.equal(degraded.isWorktree, false);

  // The failed run never entered the cache: the next request resolves again.
  const healed = await resolveProject(linked);
  assert.equal(healed.projectRoot, repo);
  assert.equal(healed.isWorktree, true);
  assert.equal(healed.branch, "feature/phantom");
});

test("a killed git during a background refresh keeps the stale project", { skip: process.platform === "win32" }, async (t) => {
  const { tempRoot, repo, linked } = await linkedWorktree(t, "pi-web-worktree-refresh-");
  const { resolveProject } = await loadSubject();
  assert.equal((await resolveProject(linked)).projectRoot, repo);
  globalThis.__piProjectCache.get(linked).expiresAt = 0;

  await withKilledGit(t, tempRoot, async () => {
    assert.equal((await resolveProject(linked)).projectRoot, repo);
    await Promise.all(globalThis.__piProjectRefresh.values());
  });

  const kept = globalThis.__piProjectCache.get(linked).info;
  assert.equal(kept.projectRoot, repo);
  assert.equal(kept.isWorktree, true);
});

test("git's own answers are cached, outside a repository or not", async (t) => {
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-plain-")));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const { resolveProject } = await loadSubject();
  const errors = t.mock.method(console, "error", () => {});

  const plain = path.join(tempRoot, "plain");
  await mkdir(plain);
  assert.equal((await resolveProject(plain)).projectRoot, plain);
  assert.ok(globalThis.__piProjectCache.has(plain));

  // A permanent failure (here safe.directory refusing the repo) is cached too,
  // so a broken cwd does not spawn git and log on every session list.
  const { repo } = await linkedWorktree(t, "pi-web-worktree-dubious-");
  // Ignore the machine's git config: GitHub's runners vouch for every path
  // with `safe.directory = *`, which would defeat the ownership refusal.
  const saved = {
    GIT_TEST_ASSUME_DIFFERENT_OWNER: process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
  process.env.GIT_CONFIG_GLOBAL = os.devNull;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    assert.equal((await resolveProject(repo)).isTopLevel, false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.ok(globalThis.__piProjectCache.has(repo));
  assert.equal(errors.mock.callCount(), 0);
});

async function gitOut(cwd, args) {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

test("New worktree checks out an existing branch, and names the checkout that already has it (#1431)", async (t) => {
  const { tempRoot, repo, linked } = await linkedWorktree(t, "pi-web-worktree-existing-");
  const origin = path.join(tempRoot, "origin");
  const clone = path.join(tempRoot, "clone");
  await git(tempRoot, ["clone", "--bare", repo, origin]);
  await git(origin, ["branch", "remote-only"]);
  await git(tempRoot, ["clone", origin, clone]);
  await git(clone, ["branch", "free"]);
  const { addWorktree, WorktreeBranchInUseError } = await loadSubject();

  // A local branch nobody has checked out: into the new worktree, not recreated.
  const free = await addWorktree(clone, "free");
  assert.equal(free.path, path.join(`${clone}-worktrees`, "free"));
  assert.equal(await gitOut(free.path, ["symbolic-ref", "HEAD"]), "refs/heads/free");
  // A branch only the remote has: a local one tracking it.
  const remote = await addWorktree(clone, "remote-only");
  assert.equal(await gitOut(remote.path, ["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/remote-only");

  const refusal = async (cwd, branch, worktreePath, missing = false) => {
    await assert.rejects(addWorktree(cwd, branch), (error) => {
      assert.ok(error instanceof WorktreeBranchInUseError, String(error));
      assert.equal(error.branch, branch);
      assert.equal(error.worktreePath, worktreePath);
      assert.equal(error.missing, missing);
      return true;
    });
  };
  // Checked out elsewhere: the main checkout, a worktree made by hand, one
  // made here (its folder is the new one's, so that is not what is reported).
  await refusal(repo, "feature/phantom", linked);
  await refusal(clone, await gitOut(clone, ["symbolic-ref", "--short", "HEAD"]), clone);
  await refusal(clone, "free", free.path);
  // A worktree whose folder is gone is not listed, and still holds its branch.
  await rm(linked, { recursive: true, force: true });
  await refusal(repo, "feature/phantom", linked, true);
});

test("New worktree again after its folder was deleted says so, not git's missing-worktree refusal (#1431)", async (t) => {
  const { repo } = await linkedWorktree(t, "pi-web-worktree-deleted-");
  const { addWorktree, listWorktrees, WorktreeBranchInUseError } = await loadSubject();
  const created = await addWorktree(repo, "foo");
  await rm(created.path, { recursive: true, force: true });
  assert.equal((await listWorktrees(repo)).some((worktree) => worktree.branch === "foo"), false);

  await assert.rejects(addWorktree(repo, "foo"), (error) => {
    assert.ok(error instanceof WorktreeBranchInUseError, String(error));
    assert.equal(error.worktreePath, created.path);
    assert.equal(error.missing, true);
    assert.match(error.message, /git worktree prune/);
    return true;
  });
  // Nothing was pruned: the entry is the user's to clear.
  assert.match(await gitOut(repo, ["worktree", "list", "--porcelain"]), /prunable/);
  await git(repo, ["worktree", "prune"]);
  assert.equal((await addWorktree(repo, "foo")).path, created.path);
});


// F107: removing a worktree never leaves part of it at its path. A checkout with ignored
// node_modules, its files listed so a test can tell whole from half-deleted.
async function checkoutWithNodeModules(t, prefix, { packages = 4, filesPerPackage = 3 } = {}) {
  const { repo } = await linkedWorktree(t, prefix);
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
  for (let i = 0; i < 20; i += 1) await writeFile(path.join(repo, `tracked-${i}.txt`), `${i}\n`);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "tracked files"]);
  const worktree = path.join(`${repo}-worktrees`, "agent");
  await git(repo, ["worktree", "add", "-b", "agent", worktree]);
  const files = Array.from({ length: 20 }, (_, i) => `tracked-${i}.txt`);
  for (let p = 0; p < packages; p += 1) {
    await mkdir(path.join(worktree, "node_modules", `pkg-${p}`), { recursive: true });
    for (let f = 0; f < filesPerPackage; f += 1) {
      const file = path.join("node_modules", `pkg-${p}`, `${f}.js`);
      await writeFile(path.join(worktree, file), "export {};\n");
      files.push(file);
    }
  }
  return { repo, worktree, files };
}

/** The checkout at `worktree` is entirely there, or not there at all; never part of it. */
function assertWholeOrGone(worktree, files) {
  if (!existsSync(worktree)) return "gone";
  const missing = files.filter((file) => !existsSync(path.join(worktree, file)));
  assert.deepEqual(missing.slice(0, 5), [], `${missing.length} of ${files.length} files missing at the kept path`);
  return "whole";
}

async function trashBeside(worktree) {
  return (await readdir(path.dirname(worktree))).filter((name) => name.startsWith(`.${path.basename(worktree)}.removing-`));
}

test("a removal killed mid-delete leaves the worktree's path whole or gone, and its branch (F107)", { skip: process.platform === "win32", timeout: 60_000 }, async (t) => {
  const { repo, worktree, files } = await checkoutWithNodeModules(t, "pi-web-worktree-kill-", { packages: 40, filesPerPackage: 100 });
  const jiti = import.meta.resolve("jiti");
  const subject = new URL("./worktree.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", [
    `const { createJiti } = await import(${JSON.stringify(jiti)});`,
    `const { removeWorktree } = await createJiti(${JSON.stringify(subject)}).import(${JSON.stringify(subject)});`,
    `await removeWorktree(${JSON.stringify(repo)}, ${JSON.stringify(worktree)});`,
  ].join("\n")], { stdio: "inherit" });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  // Kill the moment anything under the path is gone: the removal is then deleting.
  const sentinels = [...files.filter((file) => file.endsWith("/0.js")), ...files.filter((file) => file.startsWith("tracked-"))];
  let finished = false;
  void exited.then(() => { finished = true; });
  while (!finished && existsSync(worktree) && sentinels.every((file) => existsSync(path.join(worktree, file)))) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  child.kill("SIGKILL");
  const { signal } = await exited;
  assert.equal(signal, "SIGKILL", "the removal finished before it could be killed; the test proves nothing");

  assert.equal(assertWholeOrGone(worktree, files), "gone");
  assert.equal(await gitOut(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/agent"]), await gitOut(repo, ["rev-parse", "HEAD"]));
});

test("a read-only folder in ignored node_modules leaves the worktree's path gone, not half-deleted (F107)", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const { repo, worktree, files } = await checkoutWithNodeModules(t, "pi-web-worktree-readonly-");
  await chmod(path.join(worktree, "node_modules", "pkg-1"), 0o555);
  // After hooks run in order, so this one would come after the temp folder's removal.
  const restore = () => execFileAsync("chmod", ["-R", "u+w", path.dirname(worktree)]);
  const { removeWorktree } = await loadSubject();

  try {
    await removeWorktree(repo, worktree);
  } finally {
    await restore();
  }
  assert.equal(assertWholeOrGone(worktree, files), "gone");
  // The undeletable copy stays beside it, out of git's list; the branch is untouched.
  assert.equal((await trashBeside(worktree)).length, 1);
  assert.doesNotMatch(await gitOut(repo, ["worktree", "list", "--porcelain"]), /agent/);
  assert.equal(await gitOut(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/agent"]), await gitOut(repo, ["rev-parse", "HEAD"]));
});

test("a worktree with modified or untracked files, a lock or a submodule is refused and left exactly as it was (F107)", async (t) => {
  const { repo, worktree, files } = await checkoutWithNodeModules(t, "pi-web-worktree-refused-");
  const { removeWorktree, worktreeHasUncommittedFiles, worktreeRemovalRefused } = await loadSubject();
  const refused = async (pattern) => {
    await assert.rejects(removeWorktree(repo, worktree), (error) => {
      assert.match(error.message, pattern);
      assert.equal(worktreeRemovalRefused(error.message), true);
      return true;
    });
    assert.equal(assertWholeOrGone(worktree, files), "whole");
    assert.deepEqual(await trashBeside(worktree), []);
  };

  await writeFile(path.join(worktree, "draft.txt"), "uncommitted\n");
  await refused(/contains modified or untracked files/);
  assert.equal(worktreeHasUncommittedFiles(`'${worktree}' contains modified or untracked files, use --force to delete it`), true);
  await rm(path.join(worktree, "draft.txt"));
  await writeFile(path.join(worktree, "tracked-0.txt"), "changed\n");
  await refused(/contains modified or untracked files/);
  await git(worktree, ["checkout", "--", "tracked-0.txt"]);

  await git(repo, ["worktree", "lock", worktree]);
  await refused(/locked working tree/);
  await git(repo, ["worktree", "unlock", worktree]);

  const library = path.join(path.dirname(repo), "library");
  await execFileAsync("git", ["init", library]);
  await git(library, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-m", "library"]);
  await git(worktree, ["-c", "protocol.file.allow=always", "submodule", "add", library, "lib"]);
  await git(worktree, ["commit", "-m", "add submodule"]);
  await refused(/containing submodules/);

  // Forced, the same checkout goes, and its branch keeps the commit.
  await removeWorktree(repo, worktree, true);
  assert.equal(existsSync(worktree), false);
  assert.match(await gitOut(repo, ["log", "-1", "--format=%s", "agent"]), /add submodule/);
});
