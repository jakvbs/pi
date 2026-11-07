import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-double-casts.mjs", import.meta.url));
const cast = (name) => `export const ${name} = {} as unknown as Map<string, number>;\n`;

/** A git repository whose one commit holds `files` by path. */
async function repository(t, files) {
	const root = await mkdtemp(join(tmpdir(), "pi-double-casts-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	git("init", "--quiet");
	for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
	git("add", ".");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "base");
	const check = (env = {}) =>
		spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_PATH: "", ...env } });
	return { root, git, check };
}

test("a file whose double casts grow against HEAD fails with the new line; one kept or moved within the file passes", async (t) => {
	const { root, check } = await repository(t, { "a.ts": cast("a"), "b.ts": cast("b") });
	await writeFile(join(root, "a.ts"), `// moved\n${cast("a")}`);
	await writeFile(join(root, "b.ts"), cast("b") + cast("c"));
	await writeFile(join(root, "new.ts"), cast("d"));
	const result = check();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^b\.ts:2: export const c/m);
	assert.match(result.stderr, /^new\.ts:1: export const d/m);
	assert.doesNotMatch(result.stderr, /^a\.ts/m);
});

test("an exception with a future date passes, and one past its date fails even in an unchanged file", async (t) => {
	const old = `export const old = {} as unknown as Set<string>; // double-cast-ok(2020-01-01, kuba): fixture\n`;
	const { root, check } = await repository(t, { "old.ts": old });
	const valid = `export const n = {} as unknown as Set<string>; // double-cast-ok(2999-01-01, kuba): fixture\n`;
	await writeFile(join(root, "new.ts"), valid);
	const result = check();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^old\.ts:1:.*\(exception expired\)$/m);
	assert.doesNotMatch(result.stderr, /new\.ts/);
});

test("in GitHub Actions the base is the push's previous commit, and a rewritten history is skipped", async (t) => {
	const { root, git, check } = await repository(t, { "a.ts": "export {};\n" });
	const before = git("rev-parse", "HEAD").trim();
	await writeFile(join(root, "a.ts"), cast("a"));
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-am", "cast");
	const event = join(root, "..", `${before}.json`);
	t.after(() => rm(event, { force: true }));

	await writeFile(event, JSON.stringify({ before }));
	assert.equal(check({ GITHUB_EVENT_PATH: event }).status, 1);
	await writeFile(event, JSON.stringify({ before, forced: true }));
	assert.equal(check({ GITHUB_EVENT_PATH: event }).status, 0);
	assert.equal(check().status, 0);
});
