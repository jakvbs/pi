#!/usr/bin/env node
"use strict";

// `npm run dev [-- <next dev args>]`: `next dev` on the pi fork's source.
// next.config.ts sends @earendil-works/* to stubs Node loads at run time;
// preloading the fork's source resolver (as ~/.local/bin/pi does) sends every
// such import to packages/*/src of the fork holding this apps/web.
// HOST names the address (127.0.0.1), PORT the port (30141).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pathToFileURL } = require("url");

const repo = path.resolve(__dirname, "..", "..", "..");
const resolver = path.join(repo, "packages", "coding-agent", "src", "experimental", "source-resolver.ts");
if (!fs.existsSync(resolver) || !fs.existsSync(path.join(repo, "node_modules"))) {
  console.error(`dev: missing ${resolver} or ${repo}/node_modules. Run npm install in the fork's root.`);
  process.exit(1);
}

const importFlag = `--import ${pathToFileURL(resolver).href}`;
const env = {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, importFlag].filter(Boolean).join(" "),
};
const nextBin = require.resolve("next/dist/bin/next");
const args = [nextBin, "dev", "-H", process.env.HOST || "127.0.0.1", "-p", process.env.PORT || "30141", ...process.argv.slice(2)];
const child = spawn(process.execPath, args, { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
