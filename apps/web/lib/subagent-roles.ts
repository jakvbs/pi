// The roles a profile's `roles:` file defines: per role a default model (with its level) and required reading.
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { jsonErrorMessage } from "./mcp-json-error";
import { PROJECT_SETTINGS_MAX_BYTES, readRegularFileText } from "./regular-file";
import { isSubagentRoleModelReference, LEVELS_TEXT } from "./subagent-model-scope";

export interface SubagentRole {
  name: string;
  /** A model reference as `Agent`'s `model` reads it, usually `provider/modelId:level`. */
  model: string;
  /** Paths the child reads in full before any work, as written in the file. */
  reading: string[];
}

/** A profile's roles file, read, or the reason it could not be: a broken file is reported, never ignored. */
export type SubagentRoles =
  | { kind: "loaded"; path: string; roles: SubagentRole[] }
  | { kind: "invalid"; path: string; error: string };

/**
 * Reads the roles file a profile's `roles:` frontmatter names, `~/` from the home directory and a
 * relative path from the profile's own directory. The file is `{ role: { model, reading } }`, as
 * the factory's `spec/roles.json` keeps it; this is its trust boundary.
 */
export function readSubagentRoles(value: unknown, profileFile: string): SubagentRoles | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    return { kind: "invalid", path: String(value), error: "roles must be the path of a roles file" };
  }
  const path = value.trim();
  const file = path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(dirname(profileFile), path);
  let text: string | undefined;
  try {
    text = readRegularFileText(file, PROJECT_SETTINGS_MAX_BYTES);
  } catch (error) {
    return { kind: "invalid", path, error: `cannot read roles file ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (text === undefined) {
    return { kind: "invalid", path, error: `cannot read roles file ${path}: ENOENT: no such file or directory` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { kind: "invalid", path, error: `cannot read roles file ${path}: ${jsonErrorMessage(error, text)}` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { kind: "invalid", path, error: `roles file ${path} must be a JSON object of roles` };
  }
  const roles: SubagentRole[] = [];
  for (const [name, entry] of Object.entries(data)) {
    const invalid: SubagentRoles = { kind: "invalid", path, error: `roles file ${path}: role ${name} needs a model string and a reading list of paths` };
    if (typeof entry !== "object" || entry === null || !("model" in entry) || !("reading" in entry)) return invalid;
    const { model, reading } = entry;
    if (typeof model !== "string" || !model.trim() || !Array.isArray(reading) || !reading.every((item): item is string => typeof item === "string" && item.trim() !== "")) {
      return invalid;
    }
    const trimmedModel = model.trim();
    if (!isSubagentRoleModelReference(trimmedModel)) {
      return {
        kind: "invalid",
        path,
        error: `roles file ${path}: role ${name} has invalid model ${JSON.stringify(trimmedModel)}; expected provider/modelId or provider/modelId:level (${LEVELS_TEXT})`,
      };
    }
    roles.push({ name, model: trimmedModel, reading });
  }
  return { kind: "loaded", path, roles };
}

/** The role a call names, refused with the profile's roles when it has none of that name. */
export function findSubagentRole(profileName: string, roles: SubagentRoles | undefined, name: string): SubagentRole {
  if (!roles) throw new Error(`Subagent profile ${profileName} has no roles; omit role.`);
  if (roles.kind === "invalid") throw new Error(`Subagent profile ${profileName} has no usable roles: ${roles.error}`);
  const role = roles.roles.find((entry) => entry.name === name);
  if (!role) throw new Error(`Unknown role ${name} for subagent ${profileName}. Roles: ${roles.roles.map((entry) => entry.name).join(", ")}.`);
  return role;
}

/**
 * The roles as the `Agent` declaration lists them: each with its model, level and required reading,
 * marked when `inScope` says the session's `enabledModels` would refuse that model.
 */
export function subagentRolesText(roles: SubagentRoles, inScope: (model: string) => boolean): string {
  if (roles.kind === "invalid") return `Roles unavailable: ${roles.error}`;
  return `Roles: ${roles.roles.map((role) => {
    const notes = [
      role.model,
      ...(inScope(role.model) ? [] : ["outside enabledModels"]),
      ...(role.reading.length > 0 ? [`reading: ${role.reading.join(", ")}`] : []),
    ];
    return `${role.name} (${notes.join(", ")})`;
  }).join(", ")}`;
}

/** The delegated task with the role named and its required reading listed first. */
export function withRoleReading(role: SubagentRole, task: string): string {
  if (role.reading.length === 0) return `Role: ${role.name}.\n\n${task}`;
  return `Role: ${role.name}. Required reading, in full, before any work:\n${role.reading.map((path) => `- ${path}`).join("\n")}\n\n${task}`;
}
