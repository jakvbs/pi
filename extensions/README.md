# Extensions

pi extensions maintained in this fork. Each directory is a standalone package outside the root npm workspaces; pi loads it by path from `packages` in `~/.pi/agent/settings.json` (for example `../../projects/pi/extensions/web-access`).

## Own and imported extensions

An extension with an `UPSTREAM` file is a copy of a separate upstream repository without its history; the others (`auto-effort`, `composer-predictions`, `timing`) exist only here. `UPSTREAM` uses git config format:

```ini
[upstream]
	url = https://github.com/jvm/pi-mono
	branch = main
	path = packages/pi-codex-tools
	commit = 91fd55fdfd7c5516ac8d08267f34b49f1b37d050
```

`commit` is the last imported upstream commit. `path` is set only when the extension is a subdirectory of the upstream repository. Newer upstream commits are imported on top of `commit`; the `sync` skill (`~/.pi/agent/skills/sync/SKILL.md`) describes the procedure.

Fork changes to an imported extension stay small so imports stay cheap: relative imports end in `.ts` (`npm run check:ts-imports`), `package.json` is `private` with exact versions and without devDependencies the root already provides, and upstream CI, publish scripts, lockfiles of other package managers and large media are dropped.

## Dependencies

Typecheck and tests use the root `node_modules` (`npm install` in the repo root) and resolve `@earendil-works/*` to the fork's `packages/*/src`: `tsconfig.json` extends `packages/coding-agent/examples/tsconfig.json`, which maps `@earendil-works/pi-ai` to the extension view pi gives extensions at run time.

An extension with runtime dependencies of its own (`web-access`, `codex-tools`) commits its own `package-lock.json` and needs `npm ci` in its directory after a clone or a lockfile change; pi does not install dependencies of packages loaded by path. Its `.npmrc` sets `legacy-peer-deps`, so npm does not install the `@earendil-works/*` and `typebox` peers that pi provides.

## Verification

In each changed extension: `npm run typecheck && npm test`; in `observational-memory`, `npm run check`, which also fails when the committed `dist/` is stale.
