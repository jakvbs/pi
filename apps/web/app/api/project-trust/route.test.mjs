import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// Real paths: trust.json keys folders by them, and the temp folder is a link on macOS.
const root = realpathSync(await mkdtemp(join(tmpdir(), "pi-web-project-trust-route-")));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const fresh = join(root, "fresh");
const outside = join(root, "outside");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(agentDir, { recursive: true });
await mkdir(join(cwd, ".pi"), { recursive: true });
await mkdir(fresh, { recursive: true });
await mkdir(outside, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { GET, POST } = await jiti.import("./route.ts");
allowFileRoot(cwd);
allowFileRoot(fresh);

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

const settingsPath = join(cwd, ".pi", "settings.json");
const trustPath = join(agentDir, "trust.json");

// Project settings are a resource that needs trust.
await writeFile(settingsPath, JSON.stringify({ defaultThinkingLevel: "high" }));

async function get(path) {
  const query = path === undefined ? "" : `?cwd=${encodeURIComponent(path)}`;
  const response = await GET(new Request(`http://localhost/api/project-trust${query}`, { headers: { host: "localhost" } }));
  return { status: response.status, body: await response.json() };
}

test("an untrusted project's status is read, and nothing is written", async () => {
  const { status, body } = await get(cwd);
  assert.equal(status, 200);
  assert.deepEqual(body, { requiresTrust: true, trusted: false, decision: null, inherited: false });
  assert.deepEqual(await readdir(agentDir), [], "no trust decision was written");
});

test("the status follows the trust store as it is now", async (t) => {
  const store = new ProjectTrustStore(agentDir);
  t.after(() => store.set(cwd, null));
  store.set(cwd, true);
  const { body } = await get(cwd);
  assert.equal(body.trusted, true);
  assert.equal(body.decision, true);
  assert.equal(body.decisionPath, cwd);
});

test("a folder without resources that need trust says so", async () => {
  const { status, body } = await get(fresh);
  assert.equal(status, 200);
  assert.deepEqual(body, { requiresTrust: false, trusted: true, decision: null, inherited: false });
});

test("a cwd that is missing, not a folder, or outside the allowed folders is refused with a reason", async () => {
  // Absolute, inside the allowed roots as given, then a directory.
  assert.deepEqual(await get(), { status: 400, body: { error: "cwd must be an absolute path", reason: "cwd-invalid" } });
  // A relative path is not resolved against the server process's own folder.
  assert.deepEqual(await get("."), { status: 400, body: { error: "cwd must be an absolute path", reason: "cwd-invalid" } });
  assert.deepEqual(await get(settingsPath), { status: 400, body: { error: "cwd must be a directory", reason: "cwd-not-directory" } });
  assert.deepEqual(await get(outside), { status: 403, body: { error: "Access denied", reason: "cwd-denied" } });
  // A folder that does not exist gets the same answer as one outside the roots, wherever it would be.
  assert.deepEqual(await get(join(root, "missing")), { status: 403, body: { error: "Access denied", reason: "cwd-denied" } });
  assert.deepEqual(await get(join(cwd, "missing")), { status: 403, body: { error: "Access denied", reason: "cwd-denied" } });
  // A `..` is refused, not collapsed into an allowed folder.
  assert.deepEqual(await get(`${cwd}/../project`), { status: 403, body: { error: "Access denied", reason: "cwd-denied" } });

  const response = await POST(new Request("http://localhost/api/project-trust", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "localhost" },
    body: JSON.stringify({ cwd: outside }),
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access denied", reason: "cwd-denied" });
});

test("a trust store that cannot be read fails the status with a reason", async (t) => {
  t.after(() => rm(trustPath, { force: true }));
  await writeFile(trustPath, "{ not json");
  const { status, body } = await get(cwd);
  assert.equal(status, 500);
  assert.equal(body.reason, "trust-unreadable");
  assert.equal(typeof body.error, "string");
  assert.equal(body.trusted, undefined, "no status is guessed");
});

test("a trust store locked by another process fails the status until the lock is gone", async (t) => {
  // The pi CLI holds this lock while it writes; the store gives up after about 200 ms.
  const lockPath = `${trustPath}.lock`;
  t.after(() => rm(lockPath, { recursive: true, force: true }));
  await mkdir(lockPath);
  let { status, body } = await get(cwd);
  assert.equal(status, 500);
  assert.equal(body.reason, "trust-unreadable");

  await rm(lockPath, { recursive: true });
  ({ status, body } = await get(cwd));
  assert.equal(status, 200);
  assert.equal(body.trusted, false);
});

function post(body, headers = {}) {
  return POST(new Request("http://localhost/api/project-trust", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "localhost", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("POST refuses a foreign origin, a body that is not JSON, and a folder with nothing to trust, each with a reason", async () => {
  let response = await post({ cwd }, { origin: "https://evil.example" });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Untrusted API request", reason: "request-denied" });

  response = await post(JSON.stringify({ cwd }), { "Content-Type": "text/plain" });
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "Content-Type must be application/json", reason: "content-type" });

  response = await post("{ not json");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "cwd must be an absolute path", reason: "cwd-invalid" });
  response = await post({ cwd: "." });
  assert.deepEqual([response.status, (await response.json()).reason], [400, "cwd-invalid"], "a relative path is not resolved against the server's folder");

  response = await post({ cwd: fresh });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "This project has no resources that require trust",
    reason: "trust-not-required",
  });
  assert.equal(existsSync(trustPath), false, "nothing was trusted");
});

test("POST trusts the folder, and GET then reads it as trusted", async (t) => {
  t.after(() => rm(trustPath, { force: true }));
  const response = await post({ cwd });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.trusted, true);
  assert.equal(status.decisionPath, cwd);
  assert.equal(JSON.parse(await readFile(trustPath, "utf8"))[cwd], true);
  const { body } = await get(cwd);
  assert.equal(body.trusted, true);
});
