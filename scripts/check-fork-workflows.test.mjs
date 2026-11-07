import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-fork-workflows.mjs", import.meta.url));

/** Runs the check on a workflow directory holding `workflows` by file name. */
async function check(t, workflows) {
	const directory = await mkdtemp(join(tmpdir(), "pi-fork-workflows-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const [name, content] of Object.entries(workflows)) await writeFile(join(directory, name), content);
	return spawnSync(process.execPath, [script, directory], { encoding: "utf8" });
}

test("a workflow not listed as working in the fork must skip each job there, directly or through a skipped need", async (t) => {
	const result = await check(t, {
		"upload.yml": `jobs:
  build:
    if: github.repository == 'earendil-works/pi' && github.event_name == 'push'
    runs-on: ubuntu-latest
  upload:
    needs: build
    runs-on: ubuntu-latest
  report:
    needs: build
    if: always()
    runs-on: ubuntu-latest
  other:
    if: github.event_name == 'push' || github.repository == 'earendil-works/pi'
    runs-on: ubuntu-latest
`,
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /upload\.yml: job report needs earendil-works\/pi/);
	assert.match(result.stderr, /upload\.yml: job other needs earendil-works\/pi/);
	assert.doesNotMatch(result.stderr, /job (build|upload) /);
});

test("a workflow listed as working in the fork must skip there each job that uses a secret or an environment", async (t) => {
	const result = await check(t, {
		"ci.yml": `jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: gh pr list
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
  publish:
    runs-on: ubuntu-latest
    environment: npm-publish
  guarded:
    if: \${{ github.repository == 'earendil-works/pi' }}
    runs-on: ubuntu-latest
    env:
      KEY: \${{ secrets.R2_KEY }}
`,
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /ci\.yml: job publish needs environment npm-publish\n/);
	assert.doesNotMatch(result.stderr, /job (test|guarded) /);
});
