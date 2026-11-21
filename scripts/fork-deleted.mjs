#!/usr/bin/env node
// Keeps the upstream paths the fork deleted deleted: `check` fails while one is tracked, `resolve` removes them after
// a merge of upstream/main. The patterns come from fork-deleted.txt (paths of upstream/main) and from the `exclude`
// keys of every extensions/*/UPSTREAM and apps/*/UPSTREAM (paths of that tree, which extensions/upstream.mjs drops
// on import).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const usage = `Usage:
  node scripts/fork-deleted.mjs check     fail when a tracked file matches a fork-deleted pattern
  node scripts/fork-deleted.mjs resolve   git rm every file that matches one (run after git merge --no-commit upstream/main)`;

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const command = process.argv[2];

if (command === "check") {
	const files = matchingFiles();
	if (files.length > 0) {
		console.error(`These tracked files match a fork-deleted pattern:\n${files.map((file) => `  ${file}`).join("\n")}`);
		console.error(
			"The fork deleted them from upstream: git rm them (node scripts/fork-deleted.mjs resolve), or drop the pattern from fork-deleted.txt or the UPSTREAM exclude key that lists it.",
		);
		process.exit(1);
	}
} else if (command === "resolve") {
	const files = matchingFiles();
	if (files.length > 0) {
		// --literal-pathspecs: the listed names are files, not patterns.
		execFileSync("git", ["--literal-pathspecs", "rm", "-r", "-f", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], {
			cwd: root,
			input: files.join("\0"),
		});
		console.log(`Removed ${files.length} fork-deleted file(s):\n${files.map((file) => `  ${file}`).join("\n")}`);
	}
} else {
	console.error(usage);
	process.exit(1);
}

/** Tracked files (also unmerged ones) that a pattern matches, each once. */
function matchingFiles() {
	const specs = pathspecs();
	// Pathspecs of only exclusions would match every file.
	if (!specs.some((spec) => spec.startsWith(":(glob)"))) return [];
	const output = execFileSync("git", ["ls-files", "-z", "--", ...specs], { cwd: root, encoding: "utf8" });
	return [...new Set(output.split("\0").filter(Boolean))];
}

/** The git pathspecs of fork-deleted.txt and of each UPSTREAM exclude key, prefixed with that UPSTREAM's directory. */
function pathspecs() {
	const manifest = join(root, "fork-deleted.txt");
	const patterns = existsSync(manifest) ? readFileSync(manifest, "utf8").split("\n") : [];
	const specs = patterns.map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => pathspec(line, ""));
	for (const dir of upstreamDirectories()) {
		// Exit status 1 with no output: the file has no exclude key.
		const result = spawnSync("git", ["config", "-f", join(root, dir, "UPSTREAM"), "--get-all", "upstream.exclude"], {
			cwd: root,
			encoding: "utf8",
		});
		specs.push(...result.stdout.split("\n").filter(Boolean).map((pattern) => pathspec(pattern, `${dir}/`)));
	}
	return specs;
}

/** A pattern as a git glob pathspec under `prefix`: `*` stays within a directory, `**` crosses them, a directory matches everything below it, and a leading `!` keeps what it matches. */
function pathspec(pattern, prefix) {
	return pattern.startsWith("!") ? `:(exclude,glob)${prefix}${pattern.slice(1)}` : `:(glob)${prefix}${pattern}`;
}

/** extensions/<name> and apps/<name> directories with an UPSTREAM file. */
function upstreamDirectories() {
	return ["extensions", "apps"].flatMap((parent) =>
		existsSync(join(root, parent))
			? readdirSync(join(root, parent))
					.map((entry) => `${parent}/${entry}`)
					.filter((dir) => existsSync(join(root, dir, "UPSTREAM")))
			: [],
	);
}
