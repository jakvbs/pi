// `npm test` in the pi fork: `node --test` over the test globs it is given, without the tests that fail only because
// pi-web's MCP contract (lib/pi-sdk-internals.ts) no longer matches the fork's SDK. Fork commit bb266bf35 moved MCP
// OAuth sign-in from pi-coding-agent into pi-mcp, so the SDK's dist/extensions/mcp/oauth.js no longer exports
// McpSignInCancelledError and pi-web turns MCP off. F050 adapts the contract and removes this file.

import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

/** Test files that load the MCP internals at module level, or whose every test needs them. */
const SKIPPED_FILES = new Set([
  "lib/mcp-add.test.mjs",
  "lib/mcp-config-file.test.mjs",
  "lib/mcp-config-read.test.mjs",
  "lib/mcp-config-values.test.mjs",
  "lib/mcp-host.integration.test.mjs",
  "lib/mcp-import.integration.test.mjs",
  "lib/mcp-read-only-policy.integration.test.mjs",
  "lib/mcp-sign-in.integration.test.mjs",
  "lib/mcp-test.test.mjs",
  "lib/mcp-transport.test.mjs",
]);

/** Tests that need the MCP internals, in files whose other tests pass. */
const SKIPPED_TESTS = [
  // app/api/mcp/route-add.test.mjs
  "a pasted server is added to the global file, and the answer is the overview after it",
  "requests that are not an add the route can read are refused before anything is read",
  "a name the file defines is refused with a free one; an invalid one is refused",
  "a literal secret is saved globally only, and PI_WEB_PASSWORD never",
  "a header that sends a variable set on the host is added only once that variable is confirmed",
  "a project server goes only to a folder a decision trusts, and the answer carries its trust",
  "a fresh folder is trusted and written in one step, only when asked to",
  "a fresh folder that gained resources since the panel offered the step is not trusted",
  "a fresh folder with a link to nothing under .pi is not offered the step, and the step refuses it",
  "a fresh folder holding a project Pi Web never opened is not offered the step, and the step refuses it",
  "a folder whose trust would reach other folders is never trusted by the step",
  "two steps for one fresh folder at once: one trusts and adds, the other is refused and takes nothing back",
  "a write that fails after trusting a fresh folder takes the trust back",
  "a write that fails after trusting, whose trust cannot be taken back either, says the folder stays trusted",
  "a pasted literal secret read from a host variable instead may go to the project",
  // app/api/mcp/route-write.test.mjs
  "a server is switched off and on in its file, and the answer is the overview after it",
  "a server's exposure is set in its file, codemode removing the key, and the answer is the overview after it",
  "an exposure change follows the same guards as a switch",
  "requests from another page, not sent as JSON, or naming nothing to do are refused",
  "an untrusted project's file is never written; a trusted one's is",
  "an unreadable trust store keeps the project's file unwritten, and the global one writable",
  "an entry that references PI_WEB_PASSWORD is never turned on, but can be turned off and removed",
  "the group switch answers per server, so a refused one leaves the rest switched",
  "remove answers with an undo token, never the entry, and undo puts it back where it stood",
  "undo never replaces a server of the same name added since, and works again once it is gone",
  "a project removal is undone only while the project is still trusted",
  "a file that no longer parses, a server removed meanwhile, or a link outside are refused with the file untouched",
  "an entry that is not an object is refused for what it is, not as missing, and can be removed",
  "a global server is turned off and on in the project alone, through an override pi reads",
  // app/api/mcp/route.test.mjs
  "without a cwd only the global file is listed",
  "PI_WEB_DISABLE_MCP and -builtin:mcp turn MCP off with a reason, and the servers are still listed",
  // app/api/mcp/sign-in/route.test.mjs
  "a sign-in is started, polled, finished with a pasted address, and the listing shows it",
  "a cancel ends the sign-in, and a flow nobody knows is a 404",
  "only an OAuth server Pi Web would connect signs in",
  "an untrusted project's server is never contacted; a trusted one's is",
  "a project sign-in finished after trust is revoked ends signed in without connecting again",
  "a project sign-in finished after PI_WEB_DISABLE_MCP is set ends signed in without connecting again",
  "sign-out deletes the server's tokens through POST /api/mcp, under the checks of any change",
  "what a cancelled sign-in left behind without tokens is listed as stored, and Sign out removes it",
  "signing out cancels a sign-in under way and forgets what connections found",
  // app/api/mcp/test/route.test.mjs
  "a global server is tested from its file and answers with what it found",
  "with a project, a global stdio server runs in it, and the project must be an allowed folder",
  "an untrusted project's server is never started; a trusted one's is",
  "an entry Pi Web would not connect is refused before anything runs",
  "what loadMcpConfig skips is refused too: a project's auth, and a name another entry's namespace has",
  "a failure says why without the literal values in the entry",
  "a status recorded before the entry changed is not shown for the changed entry",
  "a project override is tested as the global server it changes, and its status is the override's row",
  // app/api/project-trust/route.test.mjs
  "an untrusted project's MCP servers are listed from the file, and nothing runs",
  // lib/builtin-extensions.integration.test.mjs
  "a normal session loads codemode and tool_search inactive and the MCP extension",
  "the composer's /mcp rule matches what get_commands reports and what pi runs",
  "servers an extension registers connect through Pi Web's transport",
  // lib/builtin-extensions.test.mjs
  "the MCP extension gets no servers from mcp.json but keeps autoEnableCodemode, read with fresh trust",
  // lib/mcp-host.test.mjs
  "a project's mcp.json that appears after the session started connects only once the project is trusted",
  "trust inherited from a parent folder connects a project's servers, and an exact false beneath it does not",
  "an untrusted project entry named like a global one leaves the global one connected",
  "an unreadable trust.json counts as untrusted, with one warning",
  "a trust.json still locked by another process counts as untrusted",
  "a project's mcp.json that lands between the trust read and the SDK's read is not read",
  "what a session saw reaches the listing: a connected global server, then an untrusted project entry until it is trusted",
  "a project override changes the global server in a trusted project, recorded under the override as Settings lists it",
  "mcp.json errors are logged once each instead of dropped",
  "a parse error is logged without the part of mcp.json it quotes",
  "a file with many broken entries logs a few of them and a count, once",
  "an untrusted project's entry nested thousands of levels deep stops neither the global servers nor the other reports",
  "an untrusted project declaring hundreds of servers reports only the first hundred, and keeps everyone else's records",
  // lib/mcp-sign-in.test.mjs
  "a sign-in masks the oauth.clientSecret it resolved wherever a message quotes it",
  "signing out deletes the server's credentials, cancels its sign-in, and never creates mcp-auth.json",
  "signing out stops a code exchange already on its way from storing its tokens",
  "signing out also bars a cancelled run that is still refreshing, but not a sign-in started after it",
  "a sign-in's connection gets the guard its credential store calls before writing",
  "guardedCredentialStore is the SDK's store over mcp-auth.json, whose writes call the guard first",
  // lib/pi-sdk-internals.test.mjs
  "loads every MCP internal from the SDK pi-web runs",
  "the SDK builds stdio transports from the StdioTransport class it exposes",
  "config, validation and value helpers keep the shapes pi-web relies on",
  "a project's mcp.json is read only once the project is trusted, and replaces global entries",
  // lib/subagent-mcp.integration.test.mjs
  "a child with mcp: on connects mcp.json servers before its run and calls their tools",
  "a child with read-only tools runs only MCP tools marked readOnlyHint",
  "without Code mode, a child loads codemode-exposed MCP tools through tool_search",
  "a child with Code mode calls codemode-exposed MCP tools from a script",
  "ext: selectors with mcp: on keep another extension's MCP-named tools out",
  "resume after the child closed reopens it with its MCP servers",
  "abortSubagent while a child's MCP servers connect aborts the run before it starts",
  "Stop in the child's own chat while a child's MCP servers connect aborts the run before it starts",
  "the parent's Stop while a child's MCP servers connect aborts the run before it starts",
];

const args = process.argv.slice(2);
const files = args
  .filter((arg) => !arg.startsWith("--"))
  .flatMap((pattern) => globSync(pattern))
  .filter((file) => !SKIPPED_FILES.has(file))
  .sort();
const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const skip = `--test-skip-pattern=^(?:${SKIPPED_TESTS.map(escape).join("|")})$`;
const result = spawnSync(process.execPath, [...args.filter((arg) => arg.startsWith("--")), skip, ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
