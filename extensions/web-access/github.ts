// GitHub repository URLs are cloned (shallow) instead of scraped: the agent gets the real tree,
// README or file and a local path to explore. Oversized repositories, commit-SHA URLs and failed
// clones fall back to an API view through the gh CLI.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, sep } from "node:path";

export interface GitHubUrl {
	owner: string;
	repo: string;
	ref?: string;
	path: string;
	type: "root" | "tree" | "blob";
}

export interface GitHubPage {
	title: string;
	content: string;
}

export type Run = (command: string, args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<{ code: number; stdout: string }>;

const MAX_REPO_MB = 350;
const CLONE_TIMEOUT_MS = 30_000;
const API_TIMEOUT_MS = 15_000;
const FRESH_MS = 60 * 60 * 1000;
const SWEEP_MS = 24 * 60 * 60 * 1000;
const MAX_TREE_ENTRIES = 200;
const MAX_FILE_CHARS = 100_000;
const EXPLORE_HINT = "Use `read` and `bash` tools at the path above to explore further.";
const NOISE_DIRS = new Set(["node_modules", "vendor", ".next", "dist", "build", "__pycache__", ".venv", "venv", "target", ".gradle", ".idea", ".vscode"]);
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".mp3", ".mp4", ".mov", ".wav", ".zip", ".tar", ".gz", ".7z", ".exe", ".dll", ".so", ".dylib", ".bin", ".woff", ".woff2", ".ttf", ".otf", ".pdf", ".sqlite", ".db", ".pyc", ".class", ".jar"]);
const NON_CODE_SEGMENTS = new Set(["issues", "pull", "pulls", "discussions", "releases", "wiki", "actions", "settings", "security", "projects", "compare", "commits", "tags", "branches"]);

const clones = new Map<string, Promise<string | null>>();

export function cloneRoot(): string {
	return join(tmpdir(), "pi-web-access-clones");
}

export function parseGitHubUrl(url: URL): GitHubUrl | null {
	const host = url.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") return null;
	let segments: string[];
	try {
		segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		return null;
	}
	if (segments.length < 2) return null;
	const [owner, rawRepo, action, ref, ...rest] = segments;
	const repo = rawRepo.replace(/\.git$/, "");
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") return null;
	if (segments.length === 2) return { owner, repo, path: "", type: "root" };
	if (NON_CODE_SEGMENTS.has(action.toLowerCase()) || (action !== "blob" && action !== "tree") || !ref) return null;
	return { owner, repo, ref, path: rest.join("/"), type: action };
}

export const runCommand: Run = (command, args, timeoutMs, signal) =>
	new Promise((resolve) => {
		// Own process group, so a timeout also stops git's helpers (credential prompts, remote-https).
		const child = spawn(command, args, {
			detached: true,
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
		});
		let stdout = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		const kill = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(kill, timeoutMs);
		signal?.addEventListener("abort", kill, { once: true });
		const finish = (code: number) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
			resolve({ code, stdout });
		};
		child.once("error", () => finish(-1));
		child.once("close", (code) => finish(code ?? -1));
	});

function cloneDir(info: GitHubUrl): string {
	const digest = createHash("sha256").update(JSON.stringify([info.owner, info.repo, info.ref ?? null])).digest("hex").slice(0, 12);
	return join(cloneRoot(), `${info.owner}-${info.repo}-${digest}`);
}

function isFresh(dir: string, maxAgeMs: number): boolean {
	try {
		return Date.now() - statSync(dir).mtimeMs < maxAgeMs;
	} catch {
		return false;
	}
}

/** Removes clones and leftover partial clones nobody refreshed for a day. */
function sweepClones(): void {
	for (const entry of readdirSync(cloneRoot())) {
		const dir = join(cloneRoot(), entry);
		if (!isFresh(dir, SWEEP_MS)) rmSync(dir, { recursive: true, force: true });
	}
}

async function cloneOnce(info: GitHubUrl, run: Run, signal?: AbortSignal): Promise<string | null> {
	const dir = cloneDir(info);
	if (isFresh(dir, FRESH_MS) && existsSync(join(dir, ".git"))) return dir;
	mkdirSync(cloneRoot(), { recursive: true });
	sweepClones();
	const partial = `${dir}.partial-${process.pid}-${randomBytes(4).toString("hex")}`;
	const args = ["clone", "--depth", "1", "--single-branch", ...(info.ref ? ["--branch", info.ref] : []), `https://github.com/${info.owner}/${info.repo}.git`, partial];
	const { code } = await run("git", args, CLONE_TIMEOUT_MS, signal);
	if (code !== 0) {
		rmSync(partial, { recursive: true, force: true });
		return null;
	}
	rmSync(dir, { recursive: true, force: true });
	try {
		renameSync(partial, dir);
	} catch {
		// Another process finished the same clone first; use its copy.
		rmSync(partial, { recursive: true, force: true });
	}
	const now = new Date();
	utimesSync(dir, now, now);
	return dir;
}

function clone(info: GitHubUrl, run: Run, signal?: AbortSignal): Promise<string | null> {
	const key = cloneDir(info);
	const pending = clones.get(key);
	if (pending) return pending;
	const promise = cloneOnce(info, run, signal).finally(() => clones.delete(key));
	clones.set(key, promise);
	return promise;
}

/** Resolves `relative` inside `root`, refusing `..` segments and symlinks that leave the clone. */
function insideRepo(root: string, relative: string): string | null {
	const candidate = join(root, relative);
	if (candidate !== root && !candidate.startsWith(root + sep)) return null;
	if (!existsSync(candidate)) return null;
	const real = realpathSync(candidate);
	const realRoot = realpathSync(root);
	return real === realRoot || real.startsWith(realRoot + sep) ? candidate : null;
}

function buildTree(root: string): string {
	const entries: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const name of readdirSync(dir).sort()) {
			if (entries.length >= MAX_TREE_ENTRIES) return;
			if (name === ".git") continue;
			const rel = prefix ? `${prefix}/${name}` : name;
			const stat = statSync(join(dir, name), { throwIfNoEntry: false });
			if (!stat?.isDirectory()) {
				entries.push(rel);
			} else if (NOISE_DIRS.has(name)) {
				entries.push(`${rel}/  [skipped]`);
			} else {
				entries.push(`${rel}/`);
				walk(join(dir, name), rel);
			}
		}
	};
	walk(root, "");
	if (entries.length >= MAX_TREE_ENTRIES) entries.push(`... (truncated at ${MAX_TREE_ENTRIES} entries)`);
	return entries.join("\n");
}

function listDir(dir: string): string {
	return readdirSync(dir)
		.filter((name) => name !== ".git")
		.sort()
		.map((name) => {
			const stat = statSync(join(dir, name), { throwIfNoEntry: false });
			return stat?.isDirectory() ? `  ${name}/` : `  ${name}  (${stat ? formatSize(stat.size) : "unreadable"})`;
		})
		.join("\n");
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isBinary(file: string): boolean {
	if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) return true;
	const fd = openSync(file, "r");
	try {
		const head = Buffer.alloc(512);
		return head.subarray(0, readSync(fd, head, 0, 512, 0)).includes(0);
	} finally {
		closeSync(fd);
	}
}

function capFile(content: string, fullPath?: string): string {
	if (content.length <= MAX_FILE_CHARS) return content;
	return `${content.slice(0, MAX_FILE_CHARS)}\n\n[Truncated at 100K chars.${fullPath ? ` Full file: ${fullPath}` : ""}]`;
}

function readme(root: string): string | null {
	for (const name of ["README.md", "readme.md", "README", "README.txt", "README.rst"]) {
		const path = join(root, name);
		if (existsSync(path)) return capFile(readFileSync(path, "utf8"), path);
	}
	return null;
}

/** The Markdown view of a cloned repository at the URL's path. */
export function renderClone(root: string, info: GitHubUrl): string {
	const lines = [`Repository cloned to: ${root}`, ""];
	const target = info.type === "root" ? root : insideRepo(root, info.path);
	if (!target) {
		lines.push(`Path \`${info.path}\` not found in clone. Showing repository root instead.`, "");
	}
	if (!target || target === root) {
		lines.push("## Structure", buildTree(root), "");
		const text = readme(root);
		if (text) lines.push("## README.md", text, "");
	} else if (statSync(target).isDirectory()) {
		lines.push(`## ${info.path}`, listDir(target), "");
	} else if (isBinary(target)) {
		lines.push(`## ${info.path}`, `Binary file (${formatSize(statSync(target).size)}).`, "");
	} else {
		lines.push(`## ${info.path}`, capFile(readFileSync(target, "utf8"), target), "");
	}
	lines.push(EXPLORE_HINT);
	return lines.join("\n");
}

async function ghApi(run: Run, endpoint: string, jq: string, signal?: AbortSignal): Promise<string | null> {
	const { code, stdout } = await run("gh", ["api", endpoint, "--jq", jq], API_TIMEOUT_MS, signal);
	return code === 0 && stdout.trim() ? stdout.trim() : null;
}

async function apiView(info: GitHubUrl, defaultBranch: string | null, note: string, run: Run, signal?: AbortSignal): Promise<string | null> {
	const base = `repos/${info.owner}/${info.repo}`;
	const ref = info.ref ?? defaultBranch ?? (await ghApi(run, base, ".default_branch", signal));
	if (!ref) return null;
	const lines = note ? [note, ""] : [];
	if (info.type === "blob" && info.path) {
		const encoded = await ghApi(run, `${base}/contents/${info.path}?ref=${encodeURIComponent(ref)}`, ".content", signal);
		if (!encoded) return null;
		lines.push(`## ${info.path}`, capFile(Buffer.from(encoded, "base64").toString("utf8")));
		return lines.join("\n");
	}
	const [tree, encodedReadme] = await Promise.all([
		ghApi(run, `${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`, ".tree[].path", signal),
		ghApi(run, `${base}/readme?ref=${encodeURIComponent(ref)}`, ".content", signal),
	]);
	if (!tree && !encodedReadme) return null;
	if (tree) {
		const paths = tree.split("\n");
		lines.push("## Structure", paths.slice(0, MAX_TREE_ENTRIES).join("\n"));
		if (paths.length > MAX_TREE_ENTRIES) lines.push(`... (${paths.length} total entries)`);
		lines.push("");
	}
	if (encodedReadme) lines.push("## README.md", capFile(Buffer.from(encodedReadme, "base64").toString("utf8")), "");
	lines.push("This is an API-only view. Clone the repo or use `read`/`bash` for deeper exploration.");
	return lines.join("\n");
}

/** The repository view for a GitHub code URL, or null when the URL is not one or nothing could be read (the caller then fetches the page). */
export async function fetchGitHub(url: URL, signal?: AbortSignal, run: Run = runCommand): Promise<GitHubPage | null> {
	const info = parseGitHubUrl(url);
	if (!info) return null;
	const title = info.path ? `${info.owner}/${info.repo} - ${info.path}` : `${info.owner}/${info.repo}`;
	const page = (content: string | null) => (content === null ? null : { title, content });
	if (info.ref && /^[0-9a-f]{40}$/.test(info.ref)) {
		return page(await apiView(info, null, "Note: Commit SHA URLs use the GitHub API instead of cloning.", run, signal));
	}
	const meta = await ghApi(run, `repos/${info.owner}/${info.repo}`, ".size, .default_branch", signal);
	const [sizeKb, defaultBranch] = meta ? meta.split("\n") : [];
	const sizeMb = Number(sizeKb) / 1024;
	if (sizeMb > MAX_REPO_MB) {
		const note = `Note: Repository is ${Math.round(sizeMb)}MB (threshold: ${MAX_REPO_MB}MB). Showing API-fetched content instead of a clone.`;
		return page(await apiView(info, defaultBranch ?? null, note, run, signal));
	}
	const dir = await clone(info, run, signal);
	if (signal?.aborted) return null;
	return page(dir ? renderClone(dir, info) : await apiView(info, defaultBranch ?? null, "", run, signal));
}
