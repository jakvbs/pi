// Git side of a run: its branch, the worktree it works in, and the commits it added.
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Absolute path of the main checkout that owns `path`, so runs started from a linked worktree still key on one repository. */
export function primaryCheckout(path: string): string {
	const commonDir = git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return commonDir.endsWith("/.git") ? dirname(commonDir) : git(path, ["rev-parse", "--show-toplevel"]);
}

/** Path of the worktree that has `branch` checked out, if any. */
export function worktreeOf(repo: string, branch: string): string | undefined {
	let path: string | undefined;
	for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line === `branch refs/heads/${branch}`) return path;
	}
	return undefined;
}

/**
 * Gives a run a worktree on its branch and returns the commit the run starts from. `checkout` is any checkout of
 * the repository: a new branch starts at its HEAD, so a session in a linked worktree branches from its own work.
 * An existing branch keeps its worktree, so a repair run sees the work of the run before it.
 */
export function prepareWorktree(checkout: string, branch: string, path: string): { base: string; worktree: string; created: boolean } {
	const exists = git(checkout, ["branch", "--list", branch]) !== "";
	if (!exists) {
		const base = git(checkout, ["rev-parse", "HEAD"]);
		git(checkout, ["worktree", "add", "-b", branch, path, base]);
		return { base, worktree: path, created: true };
	}
	const base = git(checkout, ["rev-parse", `refs/heads/${branch}`]);
	const existing = worktreeOf(checkout, branch);
	if (existing) return { base, worktree: existing, created: false };
	git(checkout, ["worktree", "add", path, branch]);
	return { base, worktree: path, created: false };
}

/** Removes a worktree and its branch; used when a run fails before its agent starts. */
export function removeWorktree(repo: string, branch: string, path: string): void {
	git(repo, ["worktree", "remove", "--force", path]);
	git(repo, ["branch", "-D", branch]);
}

/** `<sha> <subject>` for each commit on `branch` after `base`, oldest first. */
export function commitsSince(repo: string, base: string, branch: string): string[] {
	const out = git(repo, ["log", "--reverse", "--format=%h %s", `${base}..refs/heads/${branch}`]);
	return out ? out.split("\n") : [];
}
