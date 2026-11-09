// `npm run lint`: ESLint with pi-web's own TypeScript. typescript-eslint refuses TypeScript 7, the pi fork's root
// installs it, and npm hoists eslint-config-next to the root, where `typescript` resolves to 7. So every `typescript`
// import goes to the TypeScript pi-web depends on, then ESLint's own bin runs with this process's arguments.

import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const typescript = pathToFileURL(require.resolve("typescript")).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "typescript" ? { url: typescript, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const manifest = require.resolve("eslint/package.json");
const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
await import(pathToFileURL(join(dirname(manifest), bin.eslint)).href);
