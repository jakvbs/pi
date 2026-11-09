import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// pi-web lives in the pi fork's npm workspace as apps/web.
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sizeLimitToBytes(value) {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(value.trim());
  assert.ok(match, `unparseable SizeLimit: ${value}`);
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

test("roots Turbopack and output file tracing at the fork's workspace, where npm hoists next", async () => {
  const config = await createJiti(import.meta.url).import("../next.config.ts", { default: true });

  // Next uses outputFileTracingRoot for both when they differ.
  assert.equal(config.outputFileTracingRoot, workspaceRoot);
  assert.equal(config.turbopack.root, workspaceRoot);
});

test("raises the proxy body buffer above the upload route's 100 MB request cap", async () => {
  const config = await createJiti(import.meta.url).import("../next.config.ts", { default: true });

  assert.ok(sizeLimitToBytes(config.experimental.proxyClientMaxBodySize) > 100 * 1024 * 1024);
});

test("every pi entry the server code imports goes to a stub that require()s it at run time", async () => {
  const config = await createJiti(import.meta.url).import("../next.config.ts", { default: true });
  const projectDir = path.join(workspaceRoot, "apps", "web");
  const aliases = config.turbopack.resolveAlias;

  const sources = ["app", "components", "hooks", "lib"]
    .flatMap((dir) => readdirSync(path.join(projectDir, dir), { recursive: true }).map((file) => path.join(dir, file)))
    .concat(["instrumentation.ts", "instrumentation-node.ts", "proxy.ts"])
    .filter((file) => /\.tsx?$/.test(file));
  const imported = new Set();
  for (const file of sources) {
    const source = readFileSync(path.join(projectDir, file), "utf8");
    for (const [, statement, name] of source.matchAll(/(import\s+type\b[^"]*|import\(|from\s*)"(@earendil-works\/[^"]+)"/g)) {
      if (!statement.startsWith("import type")) imported.add(name);
    }
  }
  assert.ok(imported.has("@earendil-works/pi-coding-agent"));
  for (const name of imported) assert.ok(aliases[name], `${name} has no stub in turbopack.resolveAlias`);

  for (const [name, target] of Object.entries(aliases)) {
    const stub = readFileSync(path.join(projectDir, typeof target === "string" ? target : target.default), "utf8");
    assert.ok(stub.includes(`require(/* turbopackIgnore: true */ "${name}")`), `${name}'s stub requires it`);
  }
});
