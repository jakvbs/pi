import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./fork-deleted.mjs", import.meta.url));

/** Creates a git repository holding `files` in one commit and returns helpers to change it and run the script. */
async function setup(t, files) {
	const dir = await mkdtemp(join(tmpdir(), "pi-fork-deleted-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	// The user's global config (hooks, signing) must not reach the throwaway repository.
	const env = {
		...process.env,
		HOME: dir,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	};
	const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
	const write = async (entries) => {
		for (const [path, content] of Object.entries(entries)) {
			await mkdir(dirname(join(dir, path)), { recursive: true });
			await writeFile(join(dir, path), content);
		}
		git("add", "--", ...Object.keys(entries));
	};
	git("init", "--quiet", "-b", "main");
	await write(files);
	git("commit", "--quiet", "-m", "initial");
	const run = (command) => spawnSync(process.execPath, [script, command], { cwd: dir, env, encoding: "utf8" });
	return { git, write, run };
}

test("check passes when no tracked file matches and lists every match otherwise", async (t) => {
	const { git, write, run } = await setup(t, {
		"fork-deleted.txt": "# upstream paths the fork deleted\npackages/gone\nscripts/*.sh\n.github\n!.github/workflows/ci.yml\n",
		"packages/kept/index.ts": "kept\n",
		"scripts/nested/run.sh": "nested\n",
		".github/workflows/ci.yml": "ci\n",
	});
	const clean = run("check");
	assert.equal(clean.status, 0, clean.stderr);

	await write({
		"packages/gone/src/index.ts": "back\n",
		"scripts/release.sh": "release\n",
		".github/workflows/nix.yml": "nix\n",
		".github/ISSUE_TEMPLATE/bug.md": "bug\n",
	});
	git("commit", "--quiet", "-m", "upstream adds");
	const failed = run("check");
	assert.equal(failed.status, 1);
	assert.match(failed.stderr, /packages\/gone\/src\/index\.ts/);
	assert.match(failed.stderr, /scripts\/release\.sh/);
	assert.match(failed.stderr, /\.github\/workflows\/nix\.yml/);
	assert.match(failed.stderr, /\.github\/ISSUE_TEMPLATE\/bug\.md/);
	// `*` stays within a directory and `!` keeps a file.
	assert.doesNotMatch(failed.stderr, /nested\/run\.sh|ci\.yml|kept/);
});

test("check applies an UPSTREAM exclude key under that UPSTREAM's directory", async (t) => {
	const { run } = await setup(t, {
		"apps/web/UPSTREAM": "[upstream]\n\turl = https://example.com/web\n\tbranch = main\n\tcommit = 0\n\texclude = demo\n",
		"apps/web/demo/page.ts": "page\n",
		"apps/web/app/demo/page.ts": "kept\n",
		"extensions/ext/UPSTREAM": "[upstream]\n\turl = https://example.com/ext\n\tbranch = main\n\tcommit = 0\n",
		"extensions/ext/demo/page.ts": "kept\n",
	});
	const result = run("check");
	assert.equal(result.status, 1);
	assert.equal(result.stderr.split("\n")[1], "  apps/web/demo/page.ts");
	assert.doesNotMatch(result.stderr, /app\/demo|extensions\/ext/);
});

test("check passes when there is nothing to match", async (t) => {
	const { run } = await setup(t, { "fork-deleted.txt": "!kept.txt\n", "kept.txt": "kept\n" });
	const result = run("check");
	assert.equal(result.status, 0, result.stderr);
});

test("resolve removes modify/delete conflicts and new upstream files of deleted paths after a merge", async (t) => {
	const { git, write, run } = await setup(t, {
		"fork-deleted.txt": "packages/gone\n",
		"packages/gone/index.ts": "one\n",
		"packages/kept/index.ts": "one\n",
	});
	git("switch", "--quiet", "-c", "upstream");
	await write({ "packages/gone/index.ts": "two\n", "packages/gone/new.ts": "new\n", "packages/kept/index.ts": "two\n" });
	git("commit", "--quiet", "-m", "upstream change");
	git("switch", "--quiet", "main");
	git("rm", "--quiet", "-r", "packages/gone");
	git("commit", "--quiet", "-m", "fork deletes gone");

	const merge = spawnSync("git", ["merge", "--no-commit", "upstream"], { cwd: git("rev-parse", "--show-toplevel") });
	assert.equal(merge.status, 1);
	assert.match(git("status", "--porcelain"), /^DU packages\/gone\/index\.ts$/m);

	const resolved = run("resolve");
	assert.equal(resolved.status, 0, resolved.stderr);
	assert.match(resolved.stdout, /Removed 2 fork-deleted file\(s\)/);
	assert.equal(git("ls-files", "--unmerged"), "");
	assert.equal(git("ls-files", "packages"), "packages/kept/index.ts");
	assert.equal(run("check").status, 0);
	git("commit", "--quiet", "--no-edit");
	assert.equal(git("status", "--porcelain"), "");
});
