import { existsSync, globSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { CONFIG_DIR_NAME } from "../config.ts";
import { type GitSource, parseGitUrl } from "../utils/git.ts";
import {
	canonicalizePath,
	getPathComparisonKey,
	isLocalPath,
	normalizePath,
	pathsEqual,
	resolvePath,
} from "../utils/paths.ts";
import { type PiManifest, readPiManifest } from "./pi-manifest.ts";
import type { PackageSource, SettingsManager } from "./settings-manager.ts";
import { BUILTIN_PATH_PREFIX, getResourcePathKey } from "./source-info.ts";

export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
	changelogPath?: string;
	packageRoot?: string;
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

export interface ResolvedPaths {
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
	/** Configured packages that were skipped because they could not be loaded (npm and git sources). */
	installFailures?: PackageInstallFailure[];
}

/** A configured package that could not be loaded while resolving resources. */
export interface PackageInstallFailure {
	source: string;
	scope: SourceScope;
	message: string;
}

export interface ConfiguredPackage {
	source: string;
	scope: "user" | "project";
	filtered: boolean;
	installedPath?: string;
}

export interface PackageManager {
	resolve(): Promise<ResolvedPaths>;
	install(source: string, options?: { local?: boolean }): Promise<void>;
	installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
	remove(source: string, options?: { local?: boolean }): Promise<void>;
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
	listConfiguredPackages(): ConfiguredPackage[];
	resolveExtensionSources(
		sources: string[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths>;
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}

interface PackageManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	/** Names of built-in extensions, resolved as `builtin:<name>` extension resources. */
	builtinExtensions?: string[];
}

type SourceScope = "user" | "project" | "temporary";

type NpmSource = {
	type: "npm";
	spec: string;
	name: string;
	version?: string;
};

type LocalSource = {
	type: "local";
	path: string;
};

type ParsedSource = NpmSource | GitSource | LocalSource;

interface ResourceAccumulator {
	extensions: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	skills: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	prompts: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	themes: Map<string, { metadata: PathMetadata; enabled: boolean }>;
}

/**
 * Compute a numeric precedence rank for a resource based on its metadata.
 * Lower rank = higher precedence. Used to sort resolved resources so that
 * name-collision resolution ("first wins") produces the correct outcome.
 *
 * Precedence (highest to lowest):
 *   0  project + settings entry (source: "local", scope: "project")
 *   1  project + auto-discovered (source: "auto", scope: "project")
 *   2  user + settings entry (source: "local", scope: "user")
 *   3  user + auto-discovered (source: "auto", scope: "user")
 *   4  package resource (origin: "package")
 */
function resourcePrecedenceRank(m: PathMetadata): number {
	// Built-in extensions load after file and package extensions, whichever scope enables them.
	if (m.source === "builtin") return 5;
	if (m.origin === "package") return 4;
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}

interface PackageFilter {
	autoload?: boolean;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

type ResourceType = "extensions" | "skills" | "prompts" | "themes";

const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];

const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	prompts: /\.md$/,
	themes: /\.json$/,
};

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function getHomeDir(): string {
	return process.env.HOME || homedir();
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

function isPattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") || s.includes("*") || s.includes("?");
}

function isOverridePattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

function hasGlobPattern(s: string): boolean {
	return s.includes("*") || s.includes("?");
}

/** Glob entries discover visible paths; exact entries can target dot paths or symlinked trees. */
function expandPackageGlob(pattern: string, root: string): string[] {
	return globSync(pattern, { cwd: root })
		.map((match) => resolve(root, match))
		.filter((path) =>
			relative(root, path)
				.split(sep)
				.every((segment) => segment === ".." || !segment.startsWith(".")),
		)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		if (isPattern(entry)) {
			patterns.push(entry);
		} else {
			plain.push(entry);
		}
	}
	return { plain, patterns };
}

function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (skipNodeModules && entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDir) {
				files.push(...collectFiles(fullPath, filePattern, skipNodeModules, ig, root));
			} else if (isFile && filePattern.test(entry.name)) {
				files.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return files;
}

type SkillDiscoveryMode = "pi" | "agents";

function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });

		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (isFile && !ig.ignores(relPath)) {
				entries.push(fullPath);
				return entries;
			}
		}

		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const shouldIncludeMarkdownFile =
				isFile &&
				entry.name.endsWith(".md") &&
				!ig.ignores(relPath) &&
				((mode === "pi" && dir === root) || (mode === "agents" && dir !== root));
			if (shouldIncludeMarkdownFile) {
				entries.push(fullPath);
				continue;
			}

			if (!isDir) continue;
			if (ig.ignores(`${relPath}/`)) continue;

			entries.push(...collectSkillEntries(fullPath, mode, ig, root));
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): string[] {
	return collectSkillEntries(dir, mode);
}

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	let dir = resolvedStartDir;
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	return skillDirs;
}

function collectAutoPromptEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".md")) {
				entries.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function collectAutoThemeEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".json")) {
				entries.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function resolveExtensionEntries(dir: string): string[] | null {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = resolve(dir, extPath);
				if (existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.js");
	if (existsSync(indexTs)) {
		return [indexTs];
	}
	if (existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

function collectAutoExtensionEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	// First check if this directory itself has explicit extension entries (package.json or index)
	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	// Otherwise, discover extensions from directory contents
	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
				entries.push(fullPath);
			} else if (isDir) {
				const resolvedEntries = resolveExtensionEntries(fullPath);
				if (resolvedEntries) {
					entries.push(...resolvedEntries);
				}
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

/**
 * Collect resource files from a directory based on resource type.
 * Extensions use smart discovery (index.ts in subdirs), others use recursive collection.
 */
function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "pi");
	}
	if (resourceType === "extensions") {
		return collectAutoExtensionEntries(dir);
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

// A `pi` object counts as an explicit resource manifest only when it lists resources. Packages whose
// `pi` object holds only metadata (changelogPath, gallery image/video) still use directory auto-discovery.
function hasManifestResourceFields(manifest: PiManifest): boolean {
	return RESOURCE_TYPES.some((resourceType) => manifest[resourceType] !== undefined);
}

function isPathInside(parent: string, child: string): boolean {
	const relativePath = relative(parent, child);
	return (
		relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
	);
}

function resolvePackageChangelogPath(packageRoot: string, manifest: PiManifest | null): string | undefined {
	const changelogPath = manifest?.changelogPath ?? "CHANGELOG.md";
	if (!changelogPath) return undefined;

	const resolvedPath = resolve(packageRoot, changelogPath);
	if (!existsSync(resolvedPath)) return undefined;

	const canonicalPackageRoot = canonicalizePath(packageRoot);
	const canonicalChangelogPath = canonicalizePath(resolvedPath);
	if (!isPathInside(canonicalPackageRoot, canonicalChangelogPath)) return undefined;

	try {
		return statSync(resolvedPath).isFile() ? resolvedPath : undefined;
	} catch {
		return undefined;
	}
}

function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(normalizePath(pattern));
		if (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern)
		) {
			return true;
		}
		if (!isSkillFile) return false;
		return (
			minimatch(parentRel!, normalizedPattern) ||
			minimatch(parentName!, normalizedPattern) ||
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalizePath(normalized));
}

function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isSkillFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

function getOverridePatterns(entries: string[]): string[] {
	return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		enabled = false;
	}
	return enabled;
}

/**
 * Apply patterns to paths and return a Set of enabled paths.
 * Pattern types:
 * - Plain patterns: include matching paths
 * - `!pattern`: exclude matching paths
 * - `+path`: force-include exact path (overrides exclusions)
 * - `-path`: force-exclude exact path (overrides force-includes)
 */
function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const p of patterns) {
		if (p.startsWith("+")) {
			forceIncludes.push(p.slice(1));
		} else if (p.startsWith("-")) {
			forceExcludes.push(p.slice(1));
		} else if (p.startsWith("!")) {
			excludes.push(p.slice(1));
		} else {
			includes.push(p);
		}
	}

	// Step 1: Apply includes (or all if no includes)
	let result: string[];
	if (includes.length === 0) {
		result = [...allPaths];
	} else {
		result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
	}

	// Step 2: Apply excludes
	if (excludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
	}

	// Step 3: Force-include (add back from allPaths, overriding exclusions)
	if (forceIncludes.length > 0) {
		for (const filePath of allPaths) {
			if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
				result.push(filePath);
			}
		}
	}

	// Step 4: Force-exclude (remove even if included or force-included)
	if (forceExcludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
	}

	return new Set(result);
}

function applyAutoloadDisabledPatterns(allPaths: string[], patterns: string[], baseDir: string): Map<string, boolean> {
	const result = new Map<string, boolean>();
	for (const pattern of patterns) {
		const target = pattern.slice(
			pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!") ? 1 : 0,
		);
		const enabled = !pattern.startsWith("-") && !pattern.startsWith("!");
		const exact = pattern.startsWith("+") || pattern.startsWith("-");
		for (const filePath of allPaths) {
			if (
				exact ? matchesAnyExactPattern(filePath, [target], baseDir) : matchesAnyPattern(filePath, [target], baseDir)
			) {
				result.set(filePath, enabled);
			}
		}
	}
	return result;
}

export class DefaultPackageManager implements PackageManager {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private builtinExtensions: string[];

	constructor(options: PackageManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
		this.builtinExtensions = options.builtinExtensions ?? [];
	}

	addSourceToSettings(source: string, options?: { local?: boolean }): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const normalizedSource = this.normalizePackageSourceForSettings(source, scope);
		const matchIndex = currentPackages.findIndex((existing) => this.packageSourcesMatch(existing, source, scope));
		if (matchIndex !== -1) {
			const existing = currentPackages[matchIndex];
			if (this.getPackageSourceString(existing) === normalizedSource) {
				return false;
			}
			const nextPackages = [...currentPackages];
			nextPackages[matchIndex] =
				typeof existing === "string" ? normalizedSource : { ...existing, source: normalizedSource };
			if (scope === "project") {
				this.settingsManager.setProjectPackages(nextPackages);
			} else {
				this.settingsManager.setPackages(nextPackages);
			}
			return true;
		}
		const nextPackages = [...currentPackages, normalizedSource];
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const nextPackages = currentPackages.filter((existing) => !this.packageSourcesMatch(existing, source, scope));
		const changed = nextPackages.length !== currentPackages.length;
		if (!changed) {
			return false;
		}
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
		const parsed = this.parseSource(source);
		if (parsed.type === "local") {
			const baseDir = this.getBaseDirForScope(scope);
			const path = this.resolvePathFromBase(parsed.path, baseDir);
			return existsSync(path) ? path : undefined;
		}
		return undefined;
	}

	async resolve(): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();

		// Collect all packages with scope (project first so cwd resources win collisions)
		const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		for (const pkg of projectSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "project" });
		}
		for (const pkg of globalSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "user" });
		}

		// Dedupe: project scope wins over global for same package identity
		const packageSources = this.dedupePackages(allPackages);
		const installFailures = await this.resolvePackageSources(packageSources, accumulator);

		const globalBaseDir = this.agentDir;
		const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);

		for (const resourceType of RESOURCE_TYPES) {
			const target = this.getTargetMap(accumulator, resourceType);
			const globalEntries = (globalSettings[resourceType] ?? []) as string[];
			const projectEntries = (projectSettings[resourceType] ?? []) as string[];
			this.resolveLocalEntries(
				projectEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "project",
					origin: "top-level",
				},
				projectBaseDir,
			);
			this.resolveLocalEntries(
				globalEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "user",
					origin: "top-level",
				},
				globalBaseDir,
			);
		}

		this.addAutoDiscoveredResources(accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir);

		// Built-in extensions are enabled unless the user `extensions` setting excludes them, for example
		// with `-builtin:mcp`. A matching `+`, `-`, or `!` entry in the project setting overrides that.
		for (const name of this.builtinExtensions) {
			const path = `${BUILTIN_PATH_PREFIX}${name}`;
			const projectEnabled = applyAutoloadDisabledPatterns(
				[path],
				getOverridePatterns(projectSettings.extensions ?? []),
				projectBaseDir,
			).get(path);
			this.addResource(
				accumulator.extensions,
				path,
				{ source: "builtin", scope: projectEnabled === undefined ? "user" : "project", origin: "top-level" },
				projectEnabled ?? isEnabledByOverrides(path, globalSettings.extensions ?? [], globalBaseDir),
			);
		}

		return { ...this.toResolvedPaths(accumulator), installFailures };
	}

	async resolveExtensionSources(
		sources: string[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		const scope: SourceScope = options?.temporary ? "temporary" : options?.local ? "project" : "user";
		// `-e builtin:<name>` loads a built-in extension; the resource loader reports unknown names.
		for (const source of sources.filter((source) => source.startsWith(BUILTIN_PATH_PREFIX))) {
			this.addResource(accumulator.extensions, source, { source: "builtin", scope, origin: "top-level" }, true);
		}
		const packageSources = sources
			.filter((source) => !source.startsWith(BUILTIN_PATH_PREFIX))
			.map((source) => ({ pkg: source as PackageSource, scope }));
		const installFailures = await this.resolvePackageSources(packageSources, accumulator);
		return { ...this.toResolvedPaths(accumulator), installFailures };
	}

	listConfiguredPackages(): ConfiguredPackage[] {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const configuredPackages: ConfiguredPackage[] = [];

		for (const pkg of globalSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "user",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "user"),
			});
		}

		for (const pkg of projectSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "project",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "project"),
			});
		}

		return configuredPackages;
	}

	/** Check a local package source; npm and git sources are not supported. */
	async install(source: string, options?: { local?: boolean }): Promise<void> {
		const parsed = this.parseSource(source);
		this.assertProjectTrustedForScope(options?.local ? "project" : "user");
		if (parsed.type !== "local") {
			throw new Error(`npm and git package sources are not supported: ${source}`);
		}
		const resolved = this.resolvePath(parsed.path);
		if (!existsSync(resolved)) {
			throw new Error(`Path does not exist: ${resolved}`);
		}
	}

	async installAndPersist(source: string, options?: { local?: boolean }): Promise<void> {
		await this.install(source, options);
		this.addSourceToSettings(source, options);
	}

	/** Local package sources have nothing to uninstall; only the settings entry goes. */
	async remove(_source: string, options?: { local?: boolean }): Promise<void> {
		this.assertProjectTrustedForScope(options?.local ? "project" : "user");
	}

	async removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean> {
		await this.remove(source, options);
		return this.removeSourceFromSettings(source, options);
	}

	private async resolvePackageSources(
		sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
		accumulator: ResourceAccumulator,
	): Promise<PackageInstallFailure[]> {
		const installFailures: PackageInstallFailure[] = [];
		for (const { pkg, scope } of sources) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			const filter = typeof pkg === "object" ? pkg : undefined;
			const deltaBase = this.findAutoloadDeltaBase(pkg, scope, sources);
			const resolvedSource = deltaBase?.source ?? sourceStr;
			const resolvedScope = deltaBase?.scope ?? scope;
			const parsed = this.parseSource(resolvedSource);
			const metadata: PathMetadata = { source: sourceStr, scope, origin: "package" };

			if (parsed.type === "local") {
				const baseDir = this.getBaseDirForScope(resolvedScope);
				this.resolveLocalExtensionSource(parsed, accumulator, filter, metadata, baseDir);
				continue;
			}

			installFailures.push({
				source: resolvedSource,
				scope: resolvedScope,
				message: "npm and git package sources are not supported; configure a local path",
			});
		}
		return installFailures;
	}

	private findAutoloadDeltaBase(
		pkg: PackageSource,
		scope: SourceScope,
		sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
	): { source: string; scope: SourceScope } | undefined {
		if (scope !== "project" || typeof pkg !== "object" || pkg.autoload !== false) return undefined;
		const identity = this.getPackageIdentity(pkg.source, scope);
		const userEntry = sources.find(
			(entry) =>
				entry.scope === "user" &&
				this.getPackageIdentity(this.getPackageSourceString(entry.pkg), "user") === identity,
		);
		return userEntry ? { source: this.getPackageSourceString(userEntry.pkg), scope: "user" } : undefined;
	}

	private resolveLocalExtensionSource(
		source: LocalSource,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		const resolved = this.resolvePathFromBase(source.path, baseDir);
		if (!existsSync(resolved)) {
			return;
		}

		try {
			const stats = statSync(resolved);
			if (stats.isFile()) {
				metadata.baseDir = dirname(resolved);
				this.addResource(accumulator.extensions, resolved, metadata, true);
				return;
			}
			if (stats.isDirectory()) {
				metadata.baseDir = resolved;
				metadata.packageRoot = resolved;
				const resources = this.collectPackageResources(resolved, accumulator, filter, metadata);
				if (!resources) {
					this.addResource(accumulator.extensions, resolved, metadata, true);
				}
			}
		} catch {
			return;
		}
	}

	private getPackageSourceString(pkg: PackageSource): string {
		return typeof pkg === "string" ? pkg : pkg.source;
	}

	private getSourceMatchKeyForInput(source: string): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			return `git:${parsed.host}/${parsed.path}`;
		}
		return `local:${getPathComparisonKey(this.resolvePath(parsed.path))}`;
	}

	private getSourceMatchKeyForSettings(source: string, scope: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			return `git:${parsed.host}/${parsed.path}`;
		}
		const baseDir = this.getBaseDirForScope(scope);
		return `local:${getPathComparisonKey(this.resolvePathFromBase(parsed.path, baseDir))}`;
	}

	private packageSourcesMatch(existing: PackageSource, inputSource: string, scope: SourceScope): boolean {
		const left = this.getSourceMatchKeyForSettings(this.getPackageSourceString(existing), scope);
		const right = this.getSourceMatchKeyForInput(inputSource);
		return left === right;
	}

	private normalizePackageSourceForSettings(source: string, scope: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type !== "local") {
			return source;
		}
		const baseDir = this.getBaseDirForScope(scope);
		const resolved = this.resolvePath(parsed.path);
		const rel = relative(baseDir, resolved);
		return rel || ".";
	}

	private parseSource(source: string): ParsedSource {
		if (source.startsWith("npm:")) {
			const spec = source.slice("npm:".length).trim();
			const { name, version } = this.parseNpmSpec(spec);
			return {
				type: "npm",
				spec,
				name,
				version,
			};
		}

		if (isLocalPath(source)) {
			return { type: "local", path: source };
		}

		// Try parsing as git URL
		const gitParsed = parseGitUrl(source);
		if (gitParsed) {
			return gitParsed;
		}

		return { type: "local", path: source };
	}

	/**
	 * Get a unique identity for a package, ignoring version/ref.
	 * Used to detect when the same package is in both global and project settings.
	 * For git packages, uses normalized host/path to ensure SSH and HTTPS URLs
	 * for the same repository are treated as identical.
	 */
	private getPackageIdentity(source: string, scope?: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			// Use host/path for identity to normalize SSH and HTTPS
			return `git:${parsed.host}/${parsed.path}`;
		}
		if (scope) {
			const baseDir = this.getBaseDirForScope(scope);
			return `local:${getPathComparisonKey(this.resolvePathFromBase(parsed.path, baseDir))}`;
		}
		return `local:${getPathComparisonKey(this.resolvePath(parsed.path))}`;
	}

	/**
	 * Dedupe packages: if same package identity appears in both global and project,
	 * keep only the project one (project wins). A project entry with autoload=false
	 * is a delta over the global entry, so both are kept (delta first).
	 */
	private dedupePackages(
		packages: Array<{ pkg: PackageSource; scope: SourceScope }>,
	): Array<{ pkg: PackageSource; scope: SourceScope }> {
		const result: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		const seen = new Map<string, number>();
		for (const entry of packages) {
			const identity = this.getPackageIdentity(this.getPackageSourceString(entry.pkg), entry.scope);
			const index = seen.get(identity);
			if (index === undefined) {
				seen.set(identity, result.length);
				result.push(entry);
				continue;
			}
			const existing = result[index];
			if (existing?.scope === "project" && entry.scope === "user") {
				if (typeof existing.pkg === "object" && existing.pkg.autoload === false) result.push(entry);
			} else if (entry.scope === "project") {
				result[index] = entry;
			}
		}
		return result;
	}

	private parseNpmSpec(spec: string): { name: string; version?: string } {
		const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
		if (!match) {
			return { name: spec };
		}
		const name = match[1] ?? spec;
		const version = match[2];
		return { name, version };
	}

	private assertProjectTrustedForScope(scope: SourceScope): void {
		if (scope === "project" && !this.settingsManager.isProjectTrusted()) {
			throw new Error("Project is not trusted; refusing to access project package storage");
		}
	}

	private getBaseDirForScope(scope: SourceScope): string {
		if (scope === "project") {
			this.assertProjectTrustedForScope(scope);
			return join(this.cwd, CONFIG_DIR_NAME);
		}
		if (scope === "user") {
			return this.agentDir;
		}
		return this.cwd;
	}

	private resolvePath(input: string): string {
		return resolvePath(input, this.cwd, { homeDir: getHomeDir(), trim: true });
	}

	private resolvePathFromBase(input: string, baseDir: string): string {
		return resolvePath(input, baseDir, { homeDir: getHomeDir(), trim: true });
	}

	private collectPackageResources(
		packageRoot: string,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
	): boolean {
		const manifest = readPiManifest(join(packageRoot, "package.json"));
		const changelogPath = resolvePackageChangelogPath(packageRoot, manifest);
		if (changelogPath) {
			metadata.changelogPath = changelogPath;
		} else {
			delete metadata.changelogPath;
		}

		if (filter) {
			for (const resourceType of RESOURCE_TYPES) {
				const patterns = filter[resourceType];
				const target = this.getTargetMap(accumulator, resourceType);
				if (filter.autoload === false) {
					this.applyPackageDeltaFilter(packageRoot, patterns ?? [], resourceType, target, metadata);
				} else if (patterns !== undefined) {
					this.applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
				} else {
					this.collectDefaultResources(packageRoot, resourceType, target, metadata);
				}
			}
			return true;
		}

		if (manifest && hasManifestResourceFields(manifest)) {
			for (const resourceType of RESOURCE_TYPES) {
				const entries = manifest[resourceType];
				this.addManifestEntries(
					entries,
					packageRoot,
					resourceType,
					this.getTargetMap(accumulator, resourceType),
					metadata,
				);
			}
			return true;
		}

		let hasAnyDir = false;
		for (const resourceType of RESOURCE_TYPES) {
			const dir = join(packageRoot, resourceType);
			if (existsSync(dir)) {
				// Collect all files from the directory (all enabled by default)
				const files = collectResourceFiles(dir, resourceType);
				for (const f of files) {
					this.addResource(this.getTargetMap(accumulator, resourceType), f, metadata, true);
				}
				hasAnyDir = true;
			}
		}
		return hasAnyDir;
	}

	private collectDefaultResources(
		packageRoot: string,
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		const manifest = readPiManifest(join(packageRoot, "package.json"));
		const entries = manifest?.[resourceType];
		if (entries) {
			this.addManifestEntries(entries, packageRoot, resourceType, target, metadata);
			return;
		}
		const dir = join(packageRoot, resourceType);
		if (existsSync(dir)) {
			// Collect all files from the directory (all enabled by default)
			const files = collectResourceFiles(dir, resourceType);
			for (const f of files) {
				this.addResource(target, f, metadata, true);
			}
		}
	}

	private applyPackageFilter(
		packageRoot: string,
		userPatterns: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		const { allFiles } = this.collectManifestFiles(packageRoot, resourceType);

		if (userPatterns.length === 0) {
			// Empty array explicitly disables all resources of this type
			for (const f of allFiles) {
				this.addResource(target, f, metadata, false);
			}
			return;
		}

		// Apply user patterns
		const enabledByUser = applyPatterns(allFiles, userPatterns, packageRoot);

		for (const f of allFiles) {
			const enabled = enabledByUser.has(f);
			this.addResource(target, f, metadata, enabled);
		}
	}

	private applyPackageDeltaFilter(
		packageRoot: string,
		userPatterns: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		if (userPatterns.length === 0) {
			return;
		}

		const { allFiles } = this.collectManifestFiles(packageRoot, resourceType);
		const enabledByUser = applyAutoloadDisabledPatterns(allFiles, userPatterns, packageRoot);
		for (const [filePath, enabled] of enabledByUser) {
			this.addResource(target, filePath, metadata, enabled);
		}
	}

	/**
	 * Collect all files from a package for a resource type, applying manifest patterns.
	 * Returns { allFiles, enabledByManifest } where enabledByManifest is the set of files
	 * that pass the manifest's own patterns.
	 */
	private collectManifestFiles(
		packageRoot: string,
		resourceType: ResourceType,
	): { allFiles: string[]; enabledByManifest: Set<string> } {
		const manifest = readPiManifest(join(packageRoot, "package.json"));
		const entries = manifest?.[resourceType];
		if (entries && entries.length > 0) {
			const allFiles = this.collectFilesFromManifestEntries(entries, packageRoot, resourceType);
			const manifestPatterns = entries.filter(isOverridePattern);
			const enabledByManifest =
				manifestPatterns.length > 0 ? applyPatterns(allFiles, manifestPatterns, packageRoot) : new Set(allFiles);
			return { allFiles: Array.from(enabledByManifest), enabledByManifest };
		}

		const conventionDir = join(packageRoot, resourceType);
		if (!existsSync(conventionDir)) {
			return { allFiles: [], enabledByManifest: new Set() };
		}
		const allFiles = collectResourceFiles(conventionDir, resourceType);
		return { allFiles, enabledByManifest: new Set(allFiles) };
	}

	private addManifestEntries(
		entries: string[] | undefined,
		root: string,
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		if (!entries) return;

		const allFiles = this.collectFilesFromManifestEntries(entries, root, resourceType);
		const patterns = entries.filter(isOverridePattern);
		const enabledPaths = applyPatterns(allFiles, patterns, root);

		for (const f of allFiles) {
			if (enabledPaths.has(f)) {
				this.addResource(target, f, metadata, true);
			}
		}
	}

	private collectFilesFromManifestEntries(entries: string[], root: string, resourceType: ResourceType): string[] {
		const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
		const resolved = sourceEntries.flatMap((entry) => {
			if (!hasGlobPattern(entry)) {
				return [resolve(root, entry)];
			}

			return expandPackageGlob(entry, root);
		});
		return this.collectFilesFromPaths(resolved, resourceType);
	}

	private resolveLocalEntries(
		entries: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		if (entries.length === 0) return;

		// Collect all files from plain entries (non-pattern entries)
		const { plain, patterns } = splitPatterns(entries);
		const resolvedPlain = plain.map((p) => this.resolvePathFromBase(p, baseDir));
		const allFiles = this.collectFilesFromPaths(resolvedPlain, resourceType);

		// Determine which files are enabled based on patterns
		const enabledPaths = applyPatterns(allFiles, patterns, baseDir);

		// Add all files with their enabled state
		for (const f of allFiles) {
			this.addResource(target, f, metadata, enabledPaths.has(f));
		}
	}

	private addAutoDiscoveredResources(
		accumulator: ResourceAccumulator,
		globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
		projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
		globalBaseDir: string,
		projectBaseDir: string,
	): void {
		const userMetadata: PathMetadata = {
			source: "auto",
			scope: "user",
			origin: "top-level",
			baseDir: globalBaseDir,
		};
		const projectMetadata: PathMetadata = {
			source: "auto",
			scope: "project",
			origin: "top-level",
			baseDir: projectBaseDir,
		};

		const userOverrides = {
			extensions: (globalSettings.extensions ?? []) as string[],
			skills: (globalSettings.skills ?? []) as string[],
			prompts: (globalSettings.prompts ?? []) as string[],
			themes: (globalSettings.themes ?? []) as string[],
		};
		const projectOverrides = {
			extensions: (projectSettings.extensions ?? []) as string[],
			skills: (projectSettings.skills ?? []) as string[],
			prompts: (projectSettings.prompts ?? []) as string[],
			themes: (projectSettings.themes ?? []) as string[],
		};

		const userDirs = {
			extensions: join(globalBaseDir, "extensions"),
			skills: join(globalBaseDir, "skills"),
			prompts: join(globalBaseDir, "prompts"),
			themes: join(globalBaseDir, "themes"),
		};
		const projectDirs = {
			extensions: join(projectBaseDir, "extensions"),
			skills: join(projectBaseDir, "skills"),
			prompts: join(projectBaseDir, "prompts"),
			themes: join(projectBaseDir, "themes"),
		};
		const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
		const projectTrusted = this.settingsManager.isProjectTrusted();
		const projectAgentsSkillDirs = projectTrusted
			? collectAncestorAgentsSkillDirs(this.cwd).filter((dir) => !pathsEqual(dir, userAgentsSkillsDir))
			: [];

		const addResources = (
			resourceType: ResourceType,
			paths: string[],
			metadata: PathMetadata,
			overrides: string[],
			baseDir: string,
		) => {
			const target = this.getTargetMap(accumulator, resourceType);
			for (const path of paths) {
				const enabled = isEnabledByOverrides(path, overrides, baseDir);
				this.addResource(target, path, metadata, enabled);
			}
		};

		if (projectTrusted) {
			// Project extensions from .pi/
			addResources(
				"extensions",
				collectAutoExtensionEntries(projectDirs.extensions),
				projectMetadata,
				projectOverrides.extensions,
				projectBaseDir,
			);

			// Project skills from .pi/
			addResources(
				"skills",
				collectAutoSkillEntries(projectDirs.skills, "pi"),
				projectMetadata,
				projectOverrides.skills,
				projectBaseDir,
			);
		}

		// Project skills from .agents/ (each with its own baseDir)
		for (const agentsSkillsDir of projectAgentsSkillDirs) {
			const agentsBaseDir = dirname(agentsSkillsDir); // the .agents directory
			const agentsMetadata: PathMetadata = {
				...projectMetadata,
				baseDir: agentsBaseDir,
			};
			addResources(
				"skills",
				collectAutoSkillEntries(agentsSkillsDir, "agents"),
				agentsMetadata,
				projectOverrides.skills,
				agentsBaseDir,
			);
		}

		if (projectTrusted) {
			addResources(
				"prompts",
				collectAutoPromptEntries(projectDirs.prompts),
				projectMetadata,
				projectOverrides.prompts,
				projectBaseDir,
			);
			addResources(
				"themes",
				collectAutoThemeEntries(projectDirs.themes),
				projectMetadata,
				projectOverrides.themes,
				projectBaseDir,
			);
		}

		// User extensions from ~/.pi/agent/
		addResources(
			"extensions",
			collectAutoExtensionEntries(userDirs.extensions),
			userMetadata,
			userOverrides.extensions,
			globalBaseDir,
		);

		// User skills from ~/.pi/agent/
		addResources(
			"skills",
			collectAutoSkillEntries(userDirs.skills, "pi"),
			userMetadata,
			userOverrides.skills,
			globalBaseDir,
		);

		// User skills from ~/.agents/ (with its own baseDir)
		const userAgentsBaseDir = dirname(userAgentsSkillsDir);
		const userAgentsMetadata: PathMetadata = {
			...userMetadata,
			baseDir: userAgentsBaseDir,
		};
		addResources(
			"skills",
			collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
			userAgentsMetadata,
			userOverrides.skills,
			userAgentsBaseDir,
		);

		addResources(
			"prompts",
			collectAutoPromptEntries(userDirs.prompts),
			userMetadata,
			userOverrides.prompts,
			globalBaseDir,
		);
		addResources(
			"themes",
			collectAutoThemeEntries(userDirs.themes),
			userMetadata,
			userOverrides.themes,
			globalBaseDir,
		);
	}

	private collectFilesFromPaths(paths: string[], resourceType: ResourceType): string[] {
		const files: string[] = [];
		for (const p of paths) {
			if (!existsSync(p)) continue;

			try {
				const stats = statSync(p);
				if (stats.isFile()) {
					files.push(p);
				} else if (stats.isDirectory()) {
					files.push(...collectResourceFiles(p, resourceType));
				}
			} catch {
				// Ignore errors
			}
		}
		return files;
	}

	private getTargetMap(
		accumulator: ResourceAccumulator,
		resourceType: ResourceType,
	): Map<string, { metadata: PathMetadata; enabled: boolean }> {
		switch (resourceType) {
			case "extensions":
				return accumulator.extensions;
			case "skills":
				return accumulator.skills;
			case "prompts":
				return accumulator.prompts;
			case "themes":
				return accumulator.themes;
			default:
				throw new Error(`Unknown resource type: ${resourceType}`);
		}
	}

	private addResource(
		map: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		path: string,
		metadata: PathMetadata,
		enabled: boolean,
	): void {
		if (!path) return;
		if (!map.has(path)) {
			map.set(path, { metadata, enabled });
		}
	}

	private createAccumulator(): ResourceAccumulator {
		return {
			extensions: new Map(),
			skills: new Map(),
			prompts: new Map(),
			themes: new Map(),
		};
	}

	private toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
		const mapToResolved = (
			entries: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		): ResolvedResource[] => {
			const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
				path,
				enabled,
				metadata,
			}));
			resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

			const seen = new Set<string>();
			return resolved.filter((entry) => {
				const pathKey = getResourcePathKey(entry.path);
				if (seen.has(pathKey)) return false;
				seen.add(pathKey);
				return true;
			});
		};

		return {
			extensions: mapToResolved(accumulator.extensions),
			skills: mapToResolved(accumulator.skills),
			prompts: mapToResolved(accumulator.prompts),
			themes: mapToResolved(accumulator.themes),
		};
	}
}
