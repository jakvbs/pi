#!/usr/bin/env node
// Fetches, imports and records the upstream and reference repositories that extensions/*/UPSTREAM and apps/*/UPSTREAM name.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const usage = `Usage:
  node extensions/upstream.mjs status
  node extensions/upstream.mjs import <name> [--skip <sha>]... [-m <body>]
  node extensions/upstream.mjs record <name> [<reference>] [-m <body>]

<name> is an extension's directory name under extensions/ or an app's path, such as apps/web.

status  fetches every [upstream] and [reference] section into refs/extensions/ and lists the new commits.
import  squashes the fetched [upstream] changes into one commit together with UPSTREAM.
record  writes the fetched commit to UPSTREAM and commits it with any staged import changes in <name>.`;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		skip: { type: "string", multiple: true, default: [] },
		message: { type: "string", short: "m" },
		help: { type: "boolean", short: "h" },
	},
});
const [command, name, reference] = positionals;
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

if (values.help) {
	console.log(usage);
} else if (command === "status" && !name) {
	status();
} else if (command === "import" && name && !reference) {
	importUpstream(name, values.skip, values.message);
} else if (command === "record" && name) {
	record(section(name, reference), values.message);
} else {
	fail(usage);
}

/** Fetches every section and prints its new commits, or why there is nothing to take. */
function status() {
	const names = [
		...readdirSync(join(root, "extensions")),
		...(existsSync(join(root, "apps")) ? readdirSync(join(root, "apps")).map((entry) => `apps/${entry}`) : []),
	].filter((entry) => existsSync(join(root, directory(entry), "UPSTREAM")));
	for (const entry of names.sort()) {
		for (const current of sections(entry)) {
			git(["fetch", "--quiet", "--no-tags", current.url, `+refs/heads/${current.branch}:${current.trackingRef}`]);
			const head = revParse(current.trackingRef);
			if (head === current.commit) {
				console.log(`${current.label}: up to date at ${short(head)}`);
			} else if (!isAncestor(current.commit, head)) {
				console.log(`${current.label}: rewritten, ${short(current.commit)} is not an ancestor of ${short(head)}`);
			} else {
				const log = git(["log", "--no-merges", "--format=  %h %s", `${current.commit}..${head}`, ...pathspec(current)]);
				console.log(`${current.label}: ${short(current.commit)}..${short(head)}${current.path ? ` in ${current.path}` : ""}`);
				console.log(log.trimEnd() || `  no commit touches ${current.path}`);
				console.log(`  review: ${["git log -p", `${short(current.commit)}..${current.trackingRef}`, ...pathspec(current)].join(" ")}`);
			}
		}
	}
}

/** Squashes the fetched upstream changes except `skip` into `directory(name)` and commits them together with UPSTREAM. */
function importUpstream(name, skip, body) {
	const upstream = section(name, undefined);
	const head = revParse(upstream.trackingRef);
	if (head === upstream.commit) {
		console.log(`${upstream.label}: up to date at ${short(head)}`);
		return;
	}
	if (!isAncestor(upstream.commit, head)) {
		fail(`${upstream.label}: rewritten, ${short(upstream.commit)} is not an ancestor of ${short(head)}`);
	}
	assertNoConflicts();
	const dir = directory(name);
	if (git(["diff", "--cached", "--name-only"]).trim()) {
		fail("staged changes in index; commit or unstage them before import");
	}
	if (git(["status", "--porcelain", "--", dir]).trim()) {
		fail(`${dir} has uncommitted changes; commit or discard them before import`);
	}
	const commits = git(["rev-list", "--reverse", "--no-merges", `${upstream.commit}..${head}`, ...pathspec(upstream)])
		.split("\n")
		.filter(Boolean);
	const skipped = new Set(skip.map((sha) => revParse(`${sha}^{commit}`)));
	for (const sha of skipped) {
		if (!commits.includes(sha)) fail(`${short(sha)} is not a new upstream commit of ${name}`);
	}
	const included = commits.filter((sha) => !skipped.has(sha));
	if (included.length > 0) {
		const baseSub = subtreeOf(upstream.commit, upstream.path);
		const targetSub = skipped.size === 0 ? subtreeOf(head, upstream.path) : mergeIncludedSubtree(baseSub, included, upstream.path);
		if (targetSub !== baseSub) {
			const label = `${name} upstream ${short(upstream.commit)}..${short(head)}`;
			const baseRoot = rootTreeWithSubtree(dir, baseSub);
			const theirsRoot = rootTreeWithSubtree(dir, targetSub);
			const baseCommit = commitTree(baseRoot, [], `base ${name}`);
			const theirsCommit = commitTree(theirsRoot, [baseCommit], label);
			const cp = spawnSync("git", ["cherry-pick", "--no-commit", theirsCommit], {
				cwd: root,
				stdio: "inherit",
			});
			if (cp.status !== 0) {
				fail(
					`Conflict applying ${label}. Resolve conflicts (git add / git rm), then run node extensions/upstream.mjs record ${name}${body ? " with the same -m" : ""}.\nTo abort: git restore --staged --worktree -- ${dir} (and remove any untracked files added under ${dir}).`,
				);
			}
		}
	}
	record(upstream, body, skipped);
}

/** Writes the fetched commit of `current` to UPSTREAM and commits it (with any staged import changes in `directory`). */
function record(current, body, skipped = new Set()) {
	assertNoConflicts();
	const head = revParse(current.trackingRef);
	const dir = directory(current.name);
	const file = join(dir, "UPSTREAM");
	const from = committedCommit(file, current.id) ?? current.commit;
	git(["config", "-f", file, `${current.id}.commit`, head]);
	const scope = current.name.startsWith("apps/") ? current.name.slice("apps/".length) : "extensions";
	if (current.reference) {
		const subject = `chore(${scope}): review ${current.name} reference ${current.reference} ${short(head)}`;
		const commit = spawnSync("git", ["commit", "-m", subject, ...(body ? ["-m", body] : []), "--", file], {
			cwd: root,
			stdio: "inherit",
		});
		if (commit.status !== 0) fail("git commit failed; fix the cause and run record again");
		return;
	}
	git(["add", "--", file]);
	const staged = git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
	const outside = staged.filter((entry) => entry !== dir && !entry.startsWith(`${dir}/`));
	if (outside.length > 0) {
		fail(`staged changes outside ${dir} (${outside.join(", ")}); commit or unstage them first`);
	}
	const range = from && from !== head ? `${short(from)}..${short(head)}` : short(head);
	const subject = `chore(${scope}): import ${current.name} upstream ${range}`;
	const summary = upstreamSummary(current, from, head, skipped);
	const fullBody = [body, summary].filter(Boolean).join("\n\n");
	const commit = spawnSync("git", ["commit", "-m", subject, ...(fullBody ? ["-m", fullBody] : [])], {
		cwd: root,
		stdio: "inherit",
	});
	// Writing the same commit again is a no-op, so a rerun after a failed hook commits the staged import and UPSTREAM.
	if (commit.status !== 0) fail("git commit failed; fix the cause and run record again");
}

/** Builds the commit-body summary of upstream commits in `from..head`. */
function upstreamSummary(current, from, head, skipped) {
	if (!from || from === head || !isAncestor(from, head)) return undefined;
	const lines = git(["log", "--no-merges", "--format=%H %h %s", `${from}..${head}`, ...pathspec(current)])
		.split("\n")
		.filter(Boolean);
	if (lines.length === 0) {
		return current.path ? `No upstream commit since ${short(from)} touches ${current.path}.` : undefined;
	}
	return lines
		.map((line) => {
			const space = line.indexOf(" ");
			const sha = line.slice(0, space);
			const rest = line.slice(space + 1);
			return skipped.has(sha) ? `- [skipped] ${rest}` : `- ${rest}`;
		})
		.join("\n");
}

/** Applies each included upstream commit's subtree delta onto `baseSub` in memory via `git merge-tree`. */
function mergeIncludedSubtree(baseSub, included, path) {
	let current = baseSub;
	for (const sha of included) {
		const parentSub = subtreeOf(`${sha}^`, path);
		const commitSub = subtreeOf(sha, path);
		if (parentSub === commitSub) continue;
		if (current === parentSub) {
			current = commitSub;
			continue;
		}
		const merged = spawnSync("git", ["merge-tree", "--write-tree", `--merge-base=${parentSub}`, current, commitSub], {
			cwd: root,
			encoding: "utf8",
		});
		if (merged.status !== 0) {
			fail(`Could not cleanly skip commit(s) before ${short(sha)}: upstream commits conflict with each other.\n${merged.stdout || merged.stderr}`);
		}
		current = merged.stdout.split("\n")[0].trim();
	}
	return current;
}

/** Returns the tree OID of `path` (or the commit root tree) at `commit`, or the empty tree if absent. */
function subtreeOf(commit, path) {
	const spec = path ? `${commit}:${path.replace(/^\/+|\/+$/g, "")}` : `${commit}^{tree}`;
	const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", spec], { cwd: root, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : EMPTY_TREE;
}

/** Builds a root tree identical to HEAD except that `dir` holds `subtree` (without touching the real index). */
function rootTreeWithSubtree(dir, subtree) {
	const tmp = mkdtempSync(join(tmpdir(), "pi-upstream-"));
	const idxEnv = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
	try {
		git(["read-tree", "HEAD"], idxEnv);
		spawnSync("git", ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", dir], { cwd: root, env: idxEnv });
		if (subtree !== EMPTY_TREE) {
			git(["read-tree", `--prefix=${dir}/`, subtree], idxEnv);
		}
		return git(["write-tree"], idxEnv).trim();
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Creates an unreachable throwaway commit object for a 3-way `cherry-pick --no-commit`. */
function commitTree(tree, parents, message) {
	const parentArgs = parents.flatMap((parent) => ["-p", parent]);
	return git(["-c", "user.name=upstream", "-c", "user.email=upstream@local", "commit-tree", tree, ...parentArgs, "-m", message]).trim();
}

/** Reads the previously committed upstream SHA from `HEAD:<file>`, if present. */
function committedCommit(file, id) {
	const result = spawnSync("git", ["config", "--blob", `HEAD:${file}`, `${id}.commit`], { cwd: root, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Fails if the index currently has unresolved merge conflicts. */
function assertNoConflicts() {
	if (git(["ls-files", "--unmerged"]).trim()) {
		fail("unresolved conflicts in index; resolve them with git add/rm before running record");
	}
}

/** The [upstream] section of the UPSTREAM file of `name`, or its [reference "<reference>"] section. */
function section(name, reference) {
	const id = reference ? `reference.${reference}` : "upstream";
	const found = sections(name).find((current) => current.id === id);
	if (!found) fail(`${directory(name)}/UPSTREAM has no ${reference ? `[reference "${reference}"]` : "[upstream]"} section`);
	return found;
}

/** Every section of the UPSTREAM file of `name` with its keys and the local ref status fetches it into. */
function sections(name) {
	const file = join(root, directory(name), "UPSTREAM");
	const byId = new Map();
	for (const line of git(["config", "-f", file, "--list"]).split("\n").filter(Boolean)) {
		const key = line.slice(0, line.indexOf("="));
		const id = key.slice(0, key.lastIndexOf("."));
		const fields = byId.get(id) ?? {};
		fields[key.slice(id.length + 1)] = line.slice(key.length + 1);
		byId.set(id, fields);
	}
	return [...byId].map(([id, fields]) => {
		const reference = id.startsWith("reference.") ? id.slice("reference.".length) : undefined;
		return {
			...fields,
			name,
			id,
			reference,
			label: reference ? `${name} reference ${reference}` : `${name} upstream`,
			trackingRef: `refs/extensions/${name}/${reference ? `reference/${reference}` : "upstream"}`,
		};
	});
}

/** The directory of an extension name or an apps/<name> path, relative to the repository root. */
function directory(name) {
	return name.startsWith("apps/") ? name : join("extensions", name);
}

function pathspec(current) {
	return current.path ? ["--", current.path] : [];
}

function revParse(rev) {
	const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", rev], { cwd: root, encoding: "utf8" });
	if (result.status !== 0) fail(`${rev} does not exist; status fetches refs/extensions/`);
	return result.stdout.trim();
}

function isAncestor(ancestor, descendant) {
	return spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: root }).status === 0;
}

function short(sha) {
	return sha.slice(0, 9);
}

function git(args, env) {
	return execFileSync("git", args, { cwd: root, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
