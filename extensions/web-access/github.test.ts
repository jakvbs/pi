import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloneRoot, fetchGitHub, parseGitHubUrl, renderClone, type Run } from "./github.ts";

process.env.TMPDIR = mkdtempSync(join(tmpdir(), "web-access-github-"));

function makeRepo(dir: string): string {
	mkdirSync(join(dir, ".git"), { recursive: true });
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
	writeFileSync(join(dir, "README.md"), "# Demo\n\nHello.");
	writeFileSync(join(dir, "src", "main.ts"), "export const x = 1;\n");
	writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
	return dir;
}

/** A fake git/gh: `gh api repos/o/r` answers `meta`, `git clone` creates a repository, other gh calls answer `api`. */
function fakeRun(options: { meta?: string; cloneOk?: boolean; api?: Record<string, string> }) {
	const calls: string[] = [];
	const run: Run = async (command, args) => {
		calls.push(`${command} ${args.join(" ")}`);
		if (command === "git") {
			if (!options.cloneOk) return { code: 128, stdout: "" };
			makeRepo(args.at(-1)!);
			return { code: 0, stdout: "" };
		}
		const endpoint = args[1];
		if (/^repos\/[^/]+\/[^/]+$/.test(endpoint)) return options.meta ? { code: 0, stdout: options.meta } : { code: 1, stdout: "" };
		const match = Object.entries(options.api ?? {}).find(([prefix]) => endpoint.startsWith(prefix));
		return match ? { code: 0, stdout: match[1] } : { code: 1, stdout: "" };
	};
	return { run, calls };
}

test("parseGitHubUrl reads repository, tree and blob URLs and skips everything else", () => {
	assert.deepEqual(parseGitHubUrl(new URL("https://github.com/owner/repo")), { owner: "owner", repo: "repo", path: "", type: "root" });
	assert.deepEqual(parseGitHubUrl(new URL("https://github.com/owner/repo.git")), { owner: "owner", repo: "repo", path: "", type: "root" });
	assert.deepEqual(parseGitHubUrl(new URL("https://github.com/o/r/blob/main/docs/a%20b.md")), { owner: "o", repo: "r", ref: "main", path: "docs/a b.md", type: "blob" });
	assert.deepEqual(parseGitHubUrl(new URL("https://www.github.com/o/r/tree/v1/src")), { owner: "o", repo: "r", ref: "v1", path: "src", type: "tree" });
	for (const url of ["https://github.com/o/r/issues/1", "https://github.com/o/r/pull/2", "https://github.com/o", "https://gitlab.com/o/r", "https://github.com/-bad/r", "https://github.com/o/r/blob"]) {
		assert.equal(parseGitHubUrl(new URL(url)), null, url);
	}
});

test("renderClone shows the tree and README, a directory listing, a file, or a binary note", () => {
	const root = makeRepo(mkdtempSync(join(tmpdir(), "repo-")));
	const rootView = renderClone(root, { owner: "o", repo: "r", path: "", type: "root" });
	assert.match(rootView, new RegExp(`^Repository cloned to: ${root}\n\n## Structure\n`));
	assert.match(rootView, /README\.md\nlogo\.png\nnode_modules\/  \[skipped\]\nsrc\/\nsrc\/main\.ts/);
	assert.match(rootView, /## README\.md\n# Demo\n\nHello\./);
	assert.doesNotMatch(rootView, /\.git\//);
	assert.match(renderClone(root, { owner: "o", repo: "r", ref: "main", path: "src", type: "tree" }), /## src\n {2}main\.ts {2}\(20 B\)/);
	assert.match(renderClone(root, { owner: "o", repo: "r", ref: "main", path: "src/main.ts", type: "blob" }), /## src\/main\.ts\nexport const x = 1;/);
	assert.match(renderClone(root, { owner: "o", repo: "r", ref: "main", path: "logo.png", type: "blob" }), /Binary file \(5 B\)/);
	assert.match(renderClone(root, { owner: "o", repo: "r", ref: "main", path: "missing.md", type: "blob" }), /Path `missing.md` not found in clone\. Showing repository root instead\./);
});

test("renderClone never reads outside the clone", () => {
	const root = makeRepo(mkdtempSync(join(tmpdir(), "repo-")));
	const secret = join(mkdtempSync(join(tmpdir(), "outside-")), "secret.txt");
	writeFileSync(secret, "top secret");
	symlinkSync(secret, join(root, "link.txt"));
	for (const path of ["../outside/secret.txt", "link.txt"]) {
		const view = renderClone(root, { owner: "o", repo: "r", ref: "main", path, type: "blob" });
		assert.doesNotMatch(view, /top secret/, path);
		assert.match(view, /not found in clone/, path);
	}
});

test("fetchGitHub clones once into the clone root and reuses the fresh clone", async () => {
	const { run, calls } = fakeRun({ meta: "1024\nmain", cloneOk: true });
	const url = new URL("https://github.com/acme/widget");
	const first = await fetchGitHub(url, undefined, run);
	assert.equal(first?.title, "acme/widget");
	assert.match(first?.content ?? "", new RegExp(`^Repository cloned to: ${cloneRoot()}/acme-widget-[0-9a-f]{12}\n`));
	const second = await fetchGitHub(new URL("https://github.com/acme/widget/blob/HEAD/src/main.ts"), undefined, run);
	assert.equal(second?.title, "acme/widget - src/main.ts");
	assert.equal(calls.filter((call) => call.startsWith("git clone --depth 1 --single-branch https://github.com/acme/widget.git")).length, 1);
	assert.equal(calls.filter((call) => call.startsWith("git clone") && call.includes("--branch HEAD")).length, 1);
});

test("oversized repositories, commit SHAs and failed clones use the gh API view", async () => {
	const api = { "repos/o/big/git/trees/": "README.md\nsrc/a.ts", "repos/o/big/readme": Buffer.from("# Big").toString("base64") };
	const big = fakeRun({ meta: String(400 * 1024) + "\nmain", api });
	const view = await fetchGitHub(new URL("https://github.com/o/big"), undefined, big.run);
	assert.match(view?.content ?? "", /^Note: Repository is 400MB \(threshold: 350MB\)\. Showing API-fetched content instead of a clone\.\n\n## Structure\nREADME\.md\nsrc\/a\.ts\n\n## README\.md\n# Big/);
	assert.ok(!big.calls.some((call) => call.startsWith("git ")));

	const sha = "a".repeat(40);
	const file = fakeRun({ api: { [`repos/o/r/contents/x.ts?ref=${sha}`]: Buffer.from("const y = 2;").toString("base64") } });
	assert.match((await fetchGitHub(new URL(`https://github.com/o/r/blob/${sha}/x.ts`), undefined, file.run))?.content ?? "", /^Note: Commit SHA URLs use the GitHub API instead of cloning\.\n\n## x\.ts\nconst y = 2;$/);

	const failed = fakeRun({ meta: "10\ndev", cloneOk: false, api: { "repos/o/gone/git/trees/dev": "a.txt" } });
	assert.match((await fetchGitHub(new URL("https://github.com/o/gone"), undefined, failed.run))?.content ?? "", /^## Structure\na\.txt\n\nThis is an API-only view/);

	assert.equal(await fetchGitHub(new URL("https://github.com/o/none"), undefined, fakeRun({}).run), null);
	assert.equal(await fetchGitHub(new URL("https://example.com/o/r"), undefined, fakeRun({}).run), null);
});
