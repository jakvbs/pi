import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-pinned-deps.mjs", import.meta.url));

/** Runs the check in a fresh git repository holding `manifest` as its root package.json and `files` by path. */
async function check(t, manifest, files = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-pinned-deps-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	// The check lists package.json files through git, so outside a repository it has nothing to read.
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	await writeFile(join(root, "package.json"), JSON.stringify(manifest));
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

// #10865: internal workspace dependencies must not allow incompatible newer releases.
test("rejects internal and external registry dependency ranges in every direct dependency section", async (t) => {
	const result = await check(t, {
		dependencies: {
			"@earendil-works/pi-codemode": "^1.2.0",
			"@earendil-works/chord": "~1.2.0",
			external: "^1.0.0",
		},
		devDependencies: { "@earendil-works/pi-ai": "1.x" },
		optionalDependencies: { "@earendil-works/pi-tui": "*" },
	});
	assert.equal(result.status, 1);
	for (const dependency of [
		"dependencies.@earendil-works/pi-codemode",
		"dependencies.@earendil-works/chord",
		"dependencies.external",
		"devDependencies.@earendil-works/pi-ai",
		"optionalDependencies.@earendil-works/pi-tui",
	]) {
		assert.ok(result.stderr.includes(`${dependency} must be pinned`), result.stderr);
	}
});

test("accepts exact internal and external versions, exact registry aliases, and non-registry specifiers", async (t) => {
	const result = await check(t, {
		dependencies: {
			"@earendil-works/pi-codemode": "1.2.0",
			"@earendil-works/chord": "1.2.0",
			external: "1.0.0",
			alias: "npm:@earendil-works/pi-ai@1.1.0",
			local: "file:../local",
			workspace: "workspace:*",
		},
		devDependencies: { "@earendil-works/pi-ai": "1.2.0" },
		optionalDependencies: { "@earendil-works/pi-tui": "1.2.0-rc.1" },
	});
	assert.equal(result.status, 0, result.stderr);
});

test("rejects registry alias ranges", async (t) => {
	const result = await check(t, {
		dependencies: { alias: "npm:@earendil-works/pi-ai@^1.2.0" },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /dependencies\.alias must be pinned/);
});

test("skips a package.json that git ignores, like the one pi installs project packages into, but not an untracked one", async (t) => {
	const ranged = JSON.stringify({ dependencies: { "pi-probe": "npm:@example/pi-probe@^1.0.0" } });
	const ignored = await check(t, {}, { ".gitignore": ".pi/npm/\n", ".pi/npm/package.json": ranged });
	assert.equal(ignored.status, 0, ignored.stderr);
	const untracked = await check(t, {}, { ".gitignore": ".pi/npm/\n", "extensions/probe/package.json": ranged });
	assert.equal(untracked.status, 1);
	assert.match(untracked.stderr, /extensions\/probe\/package\.json: dependencies\.pi-probe must be pinned/);
});
