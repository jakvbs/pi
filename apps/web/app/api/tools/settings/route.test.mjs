import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-tool-settings-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

const settingsPath = path.join(agentDir, "settings.json");
const isWindows = process.platform === "win32";
const DEFAULTS = ["read", "edit", "write", "bash"];

function put(body, headers = { host: "localhost", "Content-Type": "application/json" }) {
  return PUT(new Request("http://localhost/api/tools/settings", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("reports the global tool settings", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  const initial = await GET();
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { isWindows, powerShellEnabled: false, builtinTools: DEFAULTS });
});

test("saves the built-in tools, keeping the other defaultTools entries", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m", defaultTools: ["+web_search"] }));
  const saved = await put({ builtinTools: ["read", "grep", "bash"] });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).builtinTools, ["read", "grep", "bash"]);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", defaultTools: ["+web_search", "-edit", "-write", "+grep"] });
  assert.deepEqual((await (await put({ builtinTools: DEFAULTS })).json()).builtinTools, DEFAULTS);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", defaultTools: ["+web_search"] });
  for (const builtinTools of [["read", "lookup"], "read", null]) {
    assert.equal((await put({ builtinTools })).status, 400);
  }
});

test("rejects requests that do not name exactly one valid change, with a reason the page translates", async () => {
  for (const body of [
    { codemode: "always" },
    { builtinTools: DEFAULTS, enabled: true },
    {},
    [],
    "{ not json",
  ]) {
    const response = await put(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).reason, "invalid-request", JSON.stringify(body));
  }
  const plain = await put({ builtinTools: DEFAULTS }, { host: "localhost", "Content-Type": "text/plain" });
  assert.deepEqual([plain.status, await plain.json()], [415, { error: "Content-Type must be application/json", reason: "content-type" }]);
  const foreign = await put({ builtinTools: DEFAULTS }, { host: "localhost", origin: "https://evil.example", "Content-Type": "application/json" });
  assert.deepEqual([foreign.status, await foreign.json()], [403, { error: "Untrusted API request", reason: "request-denied" }]);
});

test("keeps the PowerShell switch Windows-only", { skip: isWindows }, async () => {
  const response = await put({ enabled: true });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).reason, "invalid-request");
});

test("reports a settings file it cannot parse instead of overwriting it", async () => {
  await writeFile(settingsPath, "{ not json");
  const read = await GET();
  assert.equal(read.status, 500);
  assert.equal((await read.json()).reason, "internal");
  const write = await put({ builtinTools: DEFAULTS });
  assert.equal(write.status, 500);
  const refusal = await write.json();
  // The panel shows the diagnostic of an internal failure.
  assert.equal(refusal.reason, "internal");
  assert.match(refusal.error, /JSON/);
  assert.equal(await readFile(settingsPath, "utf8"), "{ not json");
});
