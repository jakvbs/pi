#!/usr/bin/env node
// Fetches, imports and records the upstream and reference repositories that extensions/*/UPSTREAM and apps/*/UPSTREAM name.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const usage = `Usage:
  node extensions/upstream.mjs status
  node extensions/upstream.mjs import <name> [--skip <sha>]... [-m <body>]
  node extensions/upstream.mjs record <name> [<reference>] [-m <body>]

<name> is an extension's directory name under extensions/ or an app's path, such as apps/web.

status  fetches every [upstream] and [reference] section into refs/extensions/ and lists the new commits.
import  applies the fetched [upstream] commits with git am, then records them like record.
record  writes the fetched commit to UPSTREAM and commits only that file.`;

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

/** Applies the fetched upstream commits except `skip` under the directory of `name`, then records the fetched commit. */
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
	const commits = git(["rev-list", "--reverse", "--no-merges", `${upstream.commit}..${head}`, ...pathspec(upstream)])
		.split("\n")
		.filter(Boolean);
	const skipped = new Set(skip.map((sha) => revParse(`${sha}^{commit}`)));
	for (const sha of skipped) {
		if (!commits.includes(sha)) fail(`${short(sha)} is not a new upstream commit of ${name}`);
	}
	const included = commits.filter((sha) => !skipped.has(sha));
	if (included.length > 0) {
		const patches = included.map((sha) => git(["format-patch", "--stdout", "-1", sha, ...pathspec(upstream)])).join("");
		// format-patch keeps the upstream path, so strip it and its a/ or b/ prefix before --directory adds ours.
		const strip = upstream.path ? [`-p${1 + upstream.path.split("/").filter(Boolean).length}`] : [];
		const am = spawnSync("git", ["am", "-3", ...strip, `--directory=${directory(name)}`], {
			cwd: root,
			input: patches,
			stdio: ["pipe", "inherit", "inherit"],
		});
		if (am.status !== 0) {
			fail(
				`git am stopped. Resolve the conflict, run GIT_EDITOR=true git am --continue (or git am --skip), then node extensions/upstream.mjs record ${name} with the same -m.`,
			);
		}
	}
	const untouched =
		commits.length === 0 && upstream.path
			? `No upstream commit since ${short(upstream.commit)} touches ${upstream.path}.`
			: undefined;
	record(upstream, body ?? untouched);
}

/** Writes the fetched commit of `current` to its UPSTREAM file and commits only that file. */
function record(current, body) {
	if (existsSync(resolve(root, git(["rev-parse", "--git-path", "rebase-apply"]).trim()))) {
		fail("git am is in progress; finish it with git am --continue, --skip or --abort first");
	}
	const head = revParse(current.trackingRef);
	const file = join(directory(current.name), "UPSTREAM");
	git(["config", "-f", file, `${current.id}.commit`, head]);
	const scope = current.name.startsWith("apps/") ? current.name.slice("apps/".length) : "extensions";
	const subject = current.reference
		? `chore(${scope}): review ${current.name} reference ${current.reference} ${short(head)}`
		: `chore(${scope}): import ${current.name} upstream ${short(head)}`;
	const commit = spawnSync("git", ["commit", "-m", subject, ...(body ? ["-m", body] : []), "--", file], {
		cwd: root,
		stdio: "inherit",
	});
	// Writing the same commit again is a no-op, so a rerun after a failed hook commits the same file.
	if (commit.status !== 0) fail(`git commit failed; fix the cause and run record again`);
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

function git(args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
