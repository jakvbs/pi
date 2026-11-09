import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
// pi-web lives in the pi fork as the npm workspace apps/web, so the fork's
// root lockfile installs it and its pi packages are links to the fork's own
// packages/*.
const packageLock = require("../../../package-lock.json");

// pi's packages up to 1.2.0 depend on each other with `^` ranges (1.3.0 pins
// them exactly), and an install of the published pi-web resolved them afresh.
// So every pi package in the tree is a direct dependency at the exact version
// of the fork's package, and the tree holds one copy of each. pi-web 0.12.0
// pinned only four of them, and installs after pi 1.2.0 came out paired
// pi-coding-agent 1.1.0 with pi-codemode 1.2.0, which it cannot load.
const PI_SCOPE = "@earendil-works/";
const nameOf = (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

/** The fork package an installed pi package links to, or undefined when npm installed it from the registry. */
function linkedPackage(name) {
  const entry = packageLock.packages[`node_modules/${name}`];
  return entry?.link ? packageLock.packages[entry.resolved] : undefined;
}

test("every pi package pi-web pins is a link to the fork's package at that version", () => {
  const pinned = Object.entries(packageJson.dependencies).filter(([name]) => name.startsWith(PI_SCOPE));
  assert.ok(pinned.length > 0, "pi-web depends on pi packages");
  for (const [name, version] of pinned) {
    const linked = linkedPackage(name);
    assert.ok(linked, `${name} must be a link to the fork's package`);
    assert.equal(linked.version, version, `${name} is pinned at ${version} but the fork's package is ${linked.version}`);
  }
});

test("the pi packages pi-web pins depend only on pi packages it pins too, and the tree holds one copy of each", () => {
  for (const name of Object.keys(packageJson.dependencies).filter((dependency) => dependency.startsWith(PI_SCOPE))) {
    for (const dependency of Object.keys(linkedPackage(name)?.dependencies ?? {})) {
      if (!dependency.startsWith(PI_SCOPE)) continue;
      assert.ok(packageJson.dependencies[dependency], `${name} depends on ${dependency}, which pi-web must pin`);
    }
  }
  const copies = Object.keys(packageLock.packages).filter(
    (path) => nameOf(path).startsWith(PI_SCOPE) && nameOf(path).split("/").length === 2 && path !== `node_modules/${nameOf(path)}`,
  );
  assert.deepEqual(copies, [], "second copies of pi packages");
});
