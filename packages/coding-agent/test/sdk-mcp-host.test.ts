// An app that hosts MCP servers outside a session (pi-web's settings page and sign-in routes) needs only
// the package root: config files, the connection, the default transport, OAuth sign-in and config values.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioTransport } from "@earendil-works/pi-mcp";
import { McpSignInCancelledError } from "@earendil-works/pi-mcp/oauth";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import {
	addMcpServerConfig,
	createDefaultTransport,
	getConfigValueEnvVarNames,
	getMcpToolExposure,
	isCommandConfigValue,
	loadMcpConfig,
	McpOAuthCredentialStore,
	McpServerConnection,
	removeMcpServerConfig,
	resolveConfigValueOrThrow,
	resolveHeadersOrThrow,
	signInMcpServer,
	updateMcpServerConfig,
	validateMcpServerConfig,
} from "../src/index.ts";

// Answers tools/list with one tool, `echo`, and every tool call with its `text` argument.
const ECHO_SERVER = `import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const message = JSON.parse(line);
	if (!("id" in message)) continue;
	const result = message.method === "initialize"
		? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } }
		: message.method === "tools/list"
			? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
			: { content: [{ type: "text", text: message.params.arguments.text }] };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}`;

describe("MCP host API of the package root", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-sdk-mcp-host-"));
		dirs.push(dir);
		return dir;
	}

	it("edits mcp.json, connects a server from it and calls its tool", async () => {
		const agentDir = tempDir();
		const path = join(agentDir, "mcp.json");
		writeFileSync(join(agentDir, "server.mjs"), ECHO_SERVER);
		const config = validateMcpServerConfig("echo", {
			command: process.execPath,
			args: ["server.mjs"],
			cwd: agentDir,
		});
		if (typeof config === "string") throw new Error(config);
		expect(addMcpServerConfig(path, "echo", config)).toBe(false);
		updateMcpServerConfig(path, "echo", { exposure: "direct" });
		const [entry] = loadMcpConfig({ agentDir, cwd: agentDir, projectTrusted: false }).servers;
		expect(getMcpToolExposure(entry.config, "echo")).toBe("direct");

		expect(createDefaultTransport(entry, agentDir, undefined)).toBeInstanceOf(StdioTransport);
		const connection = new McpServerConnection({
			entry,
			cwd: agentDir,
			createTransport: createDefaultTransport,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			onTools: () => {},
		});
		try {
			expect(await connection.callTool("echo", { text: "hello" }, {})).toEqual({
				content: [{ type: "text", text: "hello" }],
			});
			expect(connection.tools.map((tool) => tool.name)).toEqual(["echo"]);
		} finally {
			await connection.close();
		}

		expect(removeMcpServerConfig(path, "echo")).toBe(true);
		expect(loadMcpConfig({ agentDir, cwd: agentDir, projectTrusted: false }).servers).toEqual([]);
	});

	it("stops a sign-in whose signal is aborted with pi-mcp's McpSignInCancelledError", async () => {
		const store = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const signIn = signInMcpServer({
			serverUrl: "http://127.0.0.1:1/mcp",
			store: store.forServer("remote", "http://127.0.0.1:1/mcp"),
			settings: {},
			prompt: { showAuthorizationUrl: () => {}, promptForRedirectUrl: async () => undefined },
			signal: AbortSignal.abort(),
		});
		await expect(signIn).rejects.toBeInstanceOf(McpSignInCancelledError);
	});

	it("reads and resolves config values", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
		const header = "Bearer ${TOKEN}";
		expect(getConfigValueEnvVarNames(header)).toEqual(["TOKEN"]);
		expect(isCommandConfigValue("!printenv TOKEN")).toBe(true);
		expect(resolveConfigValueOrThrow(header, "token", { TOKEN: "t" })).toBe("Bearer t");
		expect(resolveHeadersOrThrow({ Authorization: header }, "headers", { TOKEN: "t" })).toEqual({
			Authorization: "Bearer t",
		});
	});
});
