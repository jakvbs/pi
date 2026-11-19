import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./upstream.mjs", import.meta.url));

/** Creates an upstream repository holding packages/ext (or root when upstreamPath is "") and a fork copied from its first commit. */
async function setup(t, upstreamSection = "upstream", target = "extensions/ext", upstreamPath = "packages/ext") {
	const base = await mkdtemp(join(tmpdir(), "pi-extensions-upstream-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	// The user's global config (hooks, signing) must not reach the throwaway repositories.
	const env = {
		...process.env,
		HOME: base,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
		GIT_EDITOR: "true",
	};
	const repo = async (name) => {
		const dir = join(base, name);
		await mkdir(dir);
		const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
		git("init", "--quiet", "-b", "main");
		const commit = async (message, files, deletes = []) => {
			for (const [path, content] of Object.entries(files)) {
				await mkdir(dirname(join(dir, path)), { recursive: true });
				await writeFile(join(dir, path), content);
			}
			if (Object.keys(files).length > 0) git("add", "--", ...Object.keys(files));
			for (const path of deletes) git("rm", "--quiet", "--", path);
			git("commit", "--quiet", "-m", message);
			return git("rev-parse", "HEAD");
		};
		return { dir, git, commit, read: (path) => readFile(join(dir, path), "utf8") };
	};
	const upstream = await repo("upstream");
	const fork = await repo("fork");
	const prefix = upstreamPath ? `${upstreamPath}/` : "";
	const first = await upstream.commit("add ext", {
		[`${prefix}index.ts`]: "one\n",
		...(upstreamPath ? { "README.md": "readme\n" } : {}),
	});
	const sectionHeader = upstreamSection === "upstream" ? "[upstream]" : `[reference "${upstreamSection}"]`;
	const pathLine = upstreamPath ? `\tpath = ${upstreamPath}\n` : "";
	await fork.commit("import ext", {
		[`${target}/index.ts`]: "one\n",
		[`${target}/UPSTREAM`]: `${sectionHeader}\n\turl = ${upstream.dir}\n\tbranch = main\n${pathLine}\tcommit = ${first}\n`,
	});
	const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: fork.dir, env, encoding: "utf8" });
	return { upstream, fork, first, run };
}

test("squashes upstream commits under path into one commit with range and summary", async (t) => {
	const { upstream, fork, first, run } = await setup(t);
	const c1 = await upstream.commit("change index", { "packages/ext/index.ts": "two\n" });
	const c2 = await upstream.commit("add helper", { "packages/ext/helper.ts": "help\n" });
	const head = await upstream.commit("change readme", { "README.md": "changed\n" });

	const status = run("status");
	assert.equal(status.status, 0, status.stderr);
	assert.match(status.stdout, new RegExp(`ext upstream: ${first.slice(0, 9)}\\.\\.${head.slice(0, 9)} in packages/ext`));
	assert.match(status.stdout, /change index/);
	assert.match(status.stdout, /add helper/);
	assert.doesNotMatch(status.stdout, /change readme/);

	const beforeCount = Number(fork.git("rev-list", "--count", "HEAD"));
	const imported = run("import", "ext");
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(Number(fork.git("rev-list", "--count", "HEAD")), beforeCount + 1);
	assert.equal(await fork.read("extensions/ext/index.ts"), "two\n");
	assert.equal(await fork.read("extensions/ext/helper.ts"), "help\n");
	assert.equal(fork.git("config", "-f", "extensions/ext/UPSTREAM", "upstream.commit"), head);
	assert.equal(fork.git("log", "-1", "--format=%s"), `chore(extensions): import ext upstream ${first.slice(0, 9)}..${head.slice(0, 9)}`);
	const body = fork.git("log", "-1", "--format=%b");
	assert.match(body, new RegExp(`- ${c2.slice(0, 7)} add helper`));
	assert.match(body, new RegExp(`- ${c1.slice(0, 7)} change index`));
	assert.doesNotMatch(body, /change readme/);
});

test("leaves out skipped commits and marks them in the squash commit body", async (t) => {
	const { upstream, fork, first, run } = await setup(t);
	const skipped = await upstream.commit("change index", { "packages/ext/index.ts": "two\n" });
	const kept = await upstream.commit("add extra", { "packages/ext/extra.ts": "extra\n" });
	run("status");

	const beforeCount = Number(fork.git("rev-list", "--count", "HEAD"));
	const imported = run("import", "ext", "--skip", skipped.slice(0, 9), "-m", "Skipped change index: it needs a decision.");
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(Number(fork.git("rev-list", "--count", "HEAD")), beforeCount + 1);
	assert.equal(await fork.read("extensions/ext/index.ts"), "one\n");
	assert.equal(await fork.read("extensions/ext/extra.ts"), "extra\n");
	assert.equal(fork.git("log", "-1", "--format=%s"), `chore(extensions): import ext upstream ${first.slice(0, 9)}..${kept.slice(0, 9)}`);
	const body = fork.git("log", "-1", "--format=%b");
	assert.match(body, /^Skipped change index: it needs a decision\./);
	assert.match(body, new RegExp(`- ${kept.slice(0, 7)} add extra`));
	assert.match(body, new RegExp(`- \\[skipped\\] ${skipped.slice(0, 7)} change index`));
});

test("stops on conflicts (UU and DU), follows renames, and squashes into one commit on record", async (t) => {
	const { upstream, fork, run } = await setup(t);
	const baseCommit = await upstream.commit("add more files", {
		"packages/ext/dropped.ts": "ci1\n",
		"packages/ext/old-name.ts": "line1\nline2\nline3\nline4\n",
	});
	await fork.commit("sync base", {
		"extensions/ext/old-name.ts": "line1\nline2\nline3\nfork-line4\n",
		"extensions/ext/index.ts": "fork\n",
		"extensions/ext/UPSTREAM": `[upstream]\n\turl = ${upstream.dir}\n\tbranch = main\n\tpath = packages/ext\n\tcommit = ${baseCommit}\n`,
	});
	const head = await upstream.commit(
		"upstream multi change",
		{
			"packages/ext/index.ts": "two\n",
			"packages/ext/dropped.ts": "ci2\n",
			"packages/ext/new-name.ts": "upstream-line1\nline2\nline3\nline4\n",
		},
		["packages/ext/old-name.ts"],
	);
	run("status");

	const beforeCount = Number(fork.git("rev-list", "--count", "HEAD"));
	const imported = run("import", "ext");
	assert.equal(imported.status, 1);
	assert.match(imported.stderr, /Conflict applying ext upstream/);
	// Rename merged fork edit automatically while conflicts wait for resolution.
	assert.equal(await fork.read("extensions/ext/new-name.ts"), "upstream-line1\nline2\nline3\nfork-line4\n");

	const early = run("record", "ext");
	assert.equal(early.status, 1);
	assert.match(early.stderr, /unresolved conflicts in index/);

	await writeFile(join(fork.dir, "extensions/ext/index.ts"), "fork two\n");
	fork.git("add", "extensions/ext/index.ts");
	fork.git("rm", "-f", "extensions/ext/dropped.ts");
	const recorded = run("record", "ext");
	assert.equal(recorded.status, 0, recorded.stderr);
	assert.equal(Number(fork.git("rev-list", "--count", "HEAD")), beforeCount + 1);
	assert.equal(fork.git("config", "-f", "extensions/ext/UPSTREAM", "upstream.commit"), head);
	assert.equal(await fork.read("extensions/ext/index.ts"), "fork two\n");
	assert.equal(fork.git("log", "-1", "--format=%s"), `chore(extensions): import ext upstream ${baseCommit.slice(0, 9)}..${head.slice(0, 9)}`);
	assert.equal(fork.git("status", "--porcelain"), "");
});

test("records again after a pre-commit hook rejected the squash commit", async (t) => {
	const { upstream, fork, first, run } = await setup(t);
	const head = await upstream.commit("change index", { "packages/ext/index.ts": "two\n" });
	run("status");
	const hook = join(fork.dir, ".git/hooks/pre-commit");
	await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

	assert.equal(run("import", "ext").status, 1);
	await rm(hook);
	const recorded = run("record", "ext");
	assert.equal(recorded.status, 0, recorded.stderr);
	assert.match(fork.git("show", "HEAD:extensions/ext/UPSTREAM"), new RegExp(`commit = ${head}`));
	assert.equal(await fork.read("extensions/ext/index.ts"), "two\n");
	assert.equal(fork.git("log", "-1", "--format=%s"), `chore(extensions): import ext upstream ${first.slice(0, 9)}..${head.slice(0, 9)}`);
	assert.equal(fork.git("status", "--porcelain"), "");
});

test("refuses to import when upstream rewrote the recorded commit away", async (t) => {
	const { upstream, run } = await setup(t);
	upstream.git("commit", "--quiet", "--amend", "-m", "rewritten add ext");

	const status = run("status");
	assert.equal(status.status, 0, status.stderr);
	assert.match(status.stdout, /ext upstream: rewritten/);
	const imported = run("import", "ext");
	assert.equal(imported.status, 1);
	assert.match(imported.stderr, /rewritten/);
});

test("records a reviewed reference commit without touching the extension", async (t) => {
	const { upstream, fork, run } = await setup(t, "other");
	const head = await upstream.commit("change index", { "packages/ext/index.ts": "two\n" });

	const status = run("status");
	assert.match(status.stdout, /ext reference other: .* in packages\/ext\n {2}\S+ change index/);
	assert.equal(run("import", "ext").status, 1);

	const recorded = run("record", "ext", "other", "-m", "No port candidate.");
	assert.equal(recorded.status, 0, recorded.stderr);
	assert.equal(fork.git("config", "-f", "extensions/ext/UPSTREAM", "reference.other.commit"), head);
	assert.equal(fork.git("log", "-1", "--format=%s%n%b"), `chore(extensions): review ext reference other ${head.slice(0, 9)}\nNo port candidate.`);
	assert.equal(await fork.read("extensions/ext/index.ts"), "one\n");
});

test("squashes root-level upstream commits into an app under apps/ named by its path", async (t) => {
	const { upstream, fork, first, run } = await setup(t, "upstream", "apps/web", "");
	await mkdir(join(fork.dir, "extensions"));
	await upstream.commit("change index", { "index.ts": "two\n" });
	const head = await upstream.commit("add page", { "page.ts": "page\n" });

	const status = run("status");
	assert.equal(status.status, 0, status.stderr);
	assert.match(status.stdout, new RegExp(`apps/web upstream: ${first.slice(0, 9)}\\.\\.${head.slice(0, 9)}`));

	const beforeCount = Number(fork.git("rev-list", "--count", "HEAD"));
	const imported = run("import", "apps/web");
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(Number(fork.git("rev-list", "--count", "HEAD")), beforeCount + 1);
	assert.equal(await fork.read("apps/web/index.ts"), "two\n");
	assert.equal(await fork.read("apps/web/page.ts"), "page\n");
	assert.equal(fork.git("config", "-f", "apps/web/UPSTREAM", "upstream.commit"), head);
	assert.equal(fork.git("log", "-1", "--format=%s"), `chore(web): import apps/web upstream ${first.slice(0, 9)}..${head.slice(0, 9)}`);
});

test("refuses import when unrelated changes are staged or target directory is dirty", async (t) => {
	const { upstream, fork, run } = await setup(t);
	await upstream.commit("change index", { "packages/ext/index.ts": "two\n" });
	run("status");

	await writeFile(join(fork.dir, "extensions/ext/index.ts"), "dirty\n");
	const dirtyImport = run("import", "ext");
	assert.equal(dirtyImport.status, 1);
	assert.match(dirtyImport.stderr, /has uncommitted changes/);
	fork.git("checkout", "--", "extensions/ext/index.ts");

	await writeFile(join(fork.dir, "other.txt"), "staged\n");
	fork.git("add", "other.txt");
	const stagedImport = run("import", "ext");
	assert.equal(stagedImport.status, 1);
	assert.match(stagedImport.stderr, /staged changes in index/);
});
