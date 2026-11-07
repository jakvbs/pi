// Fails when a change adds a double cast (`x as unknown as T`, `x as any as T`) to a TypeScript file. TypeScript
// checks nothing across one, so a test stand-in built with it keeps compiling when its type gains a member and fails
// only at run time: the differential test's ToolExecutionApi lacked outputLimits and the reload test's InteractiveMode
// lacked hideToolCalls, and CI on main stayed red for days each time. The repository holds hundreds from before this
// check, so only a file whose count grows fails. Locally the change is the working tree against HEAD; in GitHub
// Actions it is the pushed commits or the pull request.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const doubleCast = /\bas\s+(?:unknown|any)\s+as\b/;
// An exception approved by a person: `// double-cast-ok(2026-12-31, kuba): why TypeScript cannot express this`.
const exception = /double-cast-ok\((\d{4}-\d{2}-\d{2}), [^)]+\): \S/;
const typeScript = /\.(?:ts|tsx|mts|cts)$/;
const today = new Date().toISOString().slice(0, 10);

const failures = expiredExceptions();
const base = baseCommit();
for (const file of base === undefined ? [] : changedFiles(base)) {
	if (!existsSync(file)) continue;
	const before = unapproved(git(["show", `${base}:${file}`], true) ?? "");
	const after = unapproved(readFileSync(file, "utf8"));
	if (after.length <= before.length) continue;
	const known = new Set(before.map(({ text }) => text));
	const added = after.filter(({ text }) => !known.has(text));
	failures.push(...added.map(({ line, text }) => `${file}:${line}: ${text}`));
}

if (failures.length > 0) {
	console.error(`These double casts are new or past their exception, and TypeScript checks nothing across them:\n${failures.join("\n")}`);
	console.error(
		"Give the value its type instead: declare a stand-in as `const api: ToolExecutionApi = {...}` or `{...} satisfies ToolExecutionApi`, narrow the parameter it is passed to (for example `Pick<TUI, \"requestRender\">`), or build the real object. A person may approve an exception with `// double-cast-ok(YYYY-MM-DD, name): reason` on the line; it expires on that date.",
	);
	process.exit(1);
}

/** Exceptions anywhere in the repository whose date has passed. */
function expiredExceptions() {
	const lines = git(["grep", "-n", "-I", "-e", "double-cast-ok(", "--", "*.ts", "*.tsx", "*.mts", "*.cts"], true) ?? "";
	return lines
		.split("\n")
		.filter((line) => (exception.exec(line)?.[1] ?? today) < today)
		.map((line) => `${line.trim()} (exception expired)`);
}

/** The commit to compare against, or undefined when a CI event has none, such as a new branch or tag or a rewrite. */
function baseCommit() {
	if (!process.env.GITHUB_EVENT_PATH) return "HEAD";
	const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
	const commit = event.pull_request?.base.sha ?? event.before;
	if (!commit || /^0+$/.test(commit) || event.forced) {
		console.log("check-double-casts: no base commit for this event (new ref or rewritten history); skipped.");
		return undefined;
	}
	// actions/checkout fetches only the checked-out commit.
	if (git(["cat-file", "-e", `${commit}^{commit}`], true) === undefined) {
		git(["fetch", "--no-tags", "--depth=1", "origin", commit]);
	}
	return commit;
}

/** TypeScript files that differ from the base in the working tree, untracked ones included. */
function changedFiles(commit) {
	const changed = git(["diff", "--name-only", "-z", commit]).split("\0");
	const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0");
	return [...new Set([...changed, ...untracked])].filter((file) => typeScript.test(file));
}

/** The lines holding a double cast without an exception that is still valid. */
function unapproved(source) {
	return source
		.split("\n")
		.map((text, index) => ({ line: index + 1, text: text.trim() }))
		.filter(({ text }) => doubleCast.test(text) && !(exception.exec(text)?.[1] >= today));
}

/** Runs git; with `optional`, a failure returns undefined instead of throwing. */
function git(args, optional = false) {
	try {
		return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		if (optional) return undefined;
		throw error;
	}
}
