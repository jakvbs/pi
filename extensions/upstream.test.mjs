import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./upstream.mjs", import.meta.url));

/** Creates an upstream repository holding packages/ext and a fork whose extensions/ext was copied from its first commit. */
async function setup(t, upstreamSection = "upstream") {
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
		const commit = async (message, files) => {
			for (const [path, content] of Object.entries(files)) {
				await mkdir(dirname(join(dir, path)), { recursive: true });
				await writeFile(join(dir, path), content);
			}
			git("add", "--", ...Object.keys(files));
			git("commit", "--quiet", "-m", message);
			return git("rev-parse", "HEAD");
		};
		return { dir, git, commit, read: (path) => readFile(join(dir, path), "utf8") };
	};
	const upstream = await repo("upstream");
	const fork = await repo("fork");
	const first = await upstream.commit("add ext", { "packages/ext/index.ts": "one\n", "README.md": "readme\n" });
	const sectionHeader = upstreamSection === "upstream" ? "[upstream]" : `[reference "${upstreamSection}"]`;
	await fork.commit("import ext", {
		"extensions/ext/index.ts": "one\n",
		"extensions/ext/UPSTREAM": `${sectionHeader}\n\turl = ${upstream.dir}\n\tbranch = main\n\tpath = packages/ext\n\tcommit = ${first}\n`,
	});
	const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: fork.dir, env, encoding: "utf8" });
	return { upstream, fork, first, run };
}

test("imports only the upstream commits under path into the extension and records the fetched commit", async (t) => {
	const { upstream, fork, first, run } = await setup(t);
	await upstream.commit("change index", { "packages/ext/index.ts": "two\n" });
	const head = await upstream.commit("change readme", { "README.md": "changed\n" });

	const status = run("status");
	assert.equal(status.status, 0, status.stderr);
	assert.match(status.stdout, new RegExp(`ext upstream: ${first.slice(0, 9)}\\.\\.${head.slice(0, 9)} in packages/ext`));
	assert.match(status.stdout, /change index/);
	assert.doesNotMatch(status.stdout, /change readme/);

	const imported = run("import", "ext");
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(await fork.read("extensions/ext/index.ts"), "two\n");
	assert.equal(fork.git("config", "-f", "extensions/ext/UPSTREAM", "upstream.commit"), head);
	assert.equal(fork.git("log", "-2", "--format=%s"), `chore(extensions): import ext upstream ${head.slice(0, 9)}\nchange index`);
});

test("leaves out skipped commits and puts the body into the record commit", async (t) => {
	const { upstream, fork, run } = await setup(t);
	const skipped = await upstream.commit("change index", { "packages/ext/index.ts": "two\n" });
	await upstream.commit("add extra", { "packages/ext/extra.ts": "extra\n" });
	run("status");

	const imported = run("import", "ext", "--skip", skipped.slice(0, 9), "-m", "Skipped change index: it needs a decision.");
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(await fork.read("extensions/ext/index.ts"), "one\n");
	assert.equal(await fork.read("extensions/ext/extra.ts"), "extra\n");
	assert.equal(fork.git("log", "-1", "--format=%b"), "Skipped change index: it needs a decision.");
});

test("stops on a conflict and records once git am finishes", async (t) => {
	const { upstream, fork, run } = await setup(t);
	await fork.commit("fork change", { "extensions/ext/index.ts": "fork\n" });
	const head = await upstream.commit("change index", { "packages/ext/index.ts": "two\n" });
	run("status");

	const imported = run("import", "ext");
	assert.equal(imported.status, 1);
	assert.match(imported.stderr, /git am stopped/);
	const early = run("record", "ext");
	assert.equal(early.status, 1);
	assert.match(early.stderr, /git am is in progress/);

	await writeFile(join(fork.dir, "extensions/ext/index.ts"), "fork two\n");
	fork.git("add", "extensions/ext/index.ts");
	fork.git("am", "--continue");
	const recorded = run("record", "ext");
	assert.equal(recorded.status, 0, recorded.stderr);
	assert.equal(fork.git("config", "-f", "extensions/ext/UPSTREAM", "upstream.commit"), head);
	assert.equal(await fork.read("extensions/ext/index.ts"), "fork two\n");
});

test("records again after a pre-commit hook rejected the record commit", async (t) => {
	const { upstream, fork, run } = await setup(t);
	const head = await upstream.commit("change index", { "packages/ext/index.ts": "two\n" });
	run("status");
	const hook = join(fork.dir, ".git/hooks/pre-commit");
	await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

	assert.equal(run("import", "ext").status, 1);
	await rm(hook);
	const recorded = run("record", "ext");
	assert.equal(recorded.status, 0, recorded.stderr);
	assert.match(fork.git("show", "HEAD:extensions/ext/UPSTREAM"), new RegExp(`commit = ${head}`));
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
