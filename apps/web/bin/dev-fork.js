#!/usr/bin/env node
"use strict";

// `npm run dev:fork [-- <next dev args>]`: `next dev` on the pi fork's source.
// next.config.ts keeps @earendil-works/* external, so Node resolves them at
// runtime; preloading the fork's source resolver (as ~/.local/bin/pi does)
// sends every such import to <fork>/packages/*/src instead of node_modules.
// PI_MONO_REPO names the fork (default ~/.repos/pi); PORT the port (30141).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pathToFileURL } = require("url");

const repo = process.env.PI_MONO_REPO || path.join(os.homedir(), ".repos", "pi");
const resolver = path.join(repo, "packages", "coding-agent", "src", "experimental", "source-resolver.ts");
if (!fs.existsSync(resolver) || !fs.existsSync(path.join(repo, "node_modules"))) {
  console.error(`dev:fork: missing ${resolver} or ${repo}/node_modules. Set PI_MONO_REPO or run npm install in the fork.`);
  process.exit(1);
}

const importFlag = `--import ${pathToFileURL(resolver).href}`;
const env = {
  ...process.env,
  PI_MONO_REPO: repo,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, importFlag].filter(Boolean).join(" "),
};
const nextBin = require.resolve("next/dist/bin/next");
const args = [nextBin, "dev", "-H", "127.0.0.1", "-p", process.env.PORT || "30141", ...process.argv.slice(2)];
const child = spawn(process.execPath, args, { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
