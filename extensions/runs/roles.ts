import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

export const roleSchema = StringEnum(["worker", "review", "repair", "survey", "question"] as const, {
	description: "start: resolve the model and required reading from spec/roles.json in the session's repository, else runs.roles in pi settings.",
});
export type RunRole = Static<typeof roleSchema>;

const roleConfigSchema = Type.Object(
	{
		model: Type.String({ pattern: "^[^\\s/]+/\\S+$" }),
		reading: Type.Array(Type.String({ pattern: "^(?:/|~/).+" })),
	},
	{ additionalProperties: false },
);

const rolesSchema = Type.Object(
	{
		worker: Type.Optional(roleConfigSchema),
		review: Type.Optional(roleConfigSchema),
		repair: Type.Optional(roleConfigSchema),
		survey: Type.Optional(roleConfigSchema),
		question: Type.Optional(roleConfigSchema),
	},
	{ additionalProperties: false },
);

const settingsSchema = Type.Object({
	runs: Type.Optional(Type.Object({ roles: Type.Optional(rolesSchema) })),
});

/** Resolves one role without falling back when the repository file exists but is invalid or lacks the role. */
export function resolveRole(cwd: string, role: RunRole, settings: () => unknown) {
	let repository: string | undefined;
	try {
		repository = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		// A session outside Git can still launch into an explicit repo using its pi settings.
	}
	const file = repository ? join(repository, "spec", "roles.json") : undefined;
	let roles: Static<typeof rolesSchema>;
	let source: string;
	if (file && existsSync(file)) {
		source = file;
		roles = parse(rolesSchema, readJson(file), source);
	} else {
		source = settingsSource(cwd, role);
		roles = parse(settingsSchema, settings(), source).runs?.roles ?? {};
	}
	const config = roles[role];
	if (!config) throw new Error(`Role '${role}' is not configured in ${source} (field ${role}).`);
	return { ...config, source };
}

function parse<S extends TSchema>(schema: S, raw: unknown, source: string): Static<S> {
	// Configuration is external input; schema validation supplies both the type and field diagnostics.
	if (!Value.Check(schema, raw)) {
		const fields = Value.Errors(schema, raw).map((error) => `${error.instancePath || "/"}: ${error.message}`);
		throw new Error(`Invalid roles configuration in ${source}: ${fields.join("; ")}`);
	}
	return raw;
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`Invalid roles configuration in ${file} (field /): ${error instanceof Error ? error.message : String(error)}`);
	}
}

function settingsSource(cwd: string, role: RunRole): string {
	const project = join(cwd, CONFIG_DIR_NAME, "settings.json");
	if (existsSync(project)) {
		const raw = readJson(project);
		const modelSettings = Type.Object({
			runs: Type.Optional(
				Type.Object({ roles: Type.Optional(Type.Record(Type.String(), Type.Object({ model: Type.Optional(Type.String()) }))) }),
			),
		});
		if (Value.Check(modelSettings, raw) && raw.runs?.roles?.[role]?.model !== undefined) return `${project} (runs.roles)`;
	}
	return `${join(getAgentDir(), "settings.json")} (runs.roles)`;
}

/** Adds each reading path once, including paths already named with their home-directory shorthand. */
export function withRequiredReading(task: string, reading: string[]): string {
	const paths = [...new Set(reading.map((path) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path)))];
	const missing = paths.filter(
		(path) =>
			![path, path.startsWith(`${homedir()}/`) ? path.replace(`${homedir()}/`, "~/") : path].some((spelling) =>
				new RegExp(`(^|[\\s\`"'(\\[])${spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s\`"'\\]),;:]|\\.(?=\\s|$))`).test(task),
			),
	);
	return missing.length ? `${task}\n\nRequired reading:\n${missing.map((path) => `- ${path}`).join("\n")}` : task;
}
