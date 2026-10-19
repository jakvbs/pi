# Contributing

How to develop, test and release `pi-sub-anthropic`, for anyone changing the
code in this repository.

## Setup

```bash
git clone git@github.com:spksoft/pi-sub-anthropic.git
cd pi-sub-anthropic
npm install          # or: npm run link:dev  — reuse an installed pi's node_modules
pi install "$PWD"    # load this checkout into pi; the path is recorded, nothing is copied
```

`npm run link:dev` symlinks `node_modules` at an installed pi, which is an
alternative to `npm install` for type resolution. Point it at a package
explicitly if auto-detection fails:

```bash
npm run link:dev -- /path/to/@earendil-works/pi-coding-agent
```

`pi remove "$PWD"` unloads it again; `/reload` in a running pi picks up edits.

Everything runs under `node --experimental-strip-types` (Node >= 22.6). There is
**no build step**; do not add one. pi loads the extension with the Node that
runs pi — not necessarily the `node` first on your `PATH` — and that interpreter
must be >= 22.6 or type stripping fails at load.

There are no runtime npm dependencies. The Messages API is spoken directly over
`fetch`.

## Layout

| path | role |
|---|---|
| `index.ts` | entry point: `pi.registerProvider("pi-sub-anthropic", …)` + model catalog |
| `oauth.ts` | OAuth login/refresh (PKCE, callback port 54545) + bootstrap identity |
| `stream.ts` | Messages streaming: headers, token clamp, tool prefixing, SSE parsing, system-prompt relocation |
| `fingerprint.ts` | pinned wire constants, beta profiles, billing header, XXH64, `cch` patch |
| `wire-test.ts` | 66 assertions against a mock Anthropic HTTP server; no credentials, no network |
| `compare-bun.ts` / `verify-xxhash.ts` | XXH64 conformance (vs bun native / canonical vectors) |
| `diagnostics/*.ts` | one-off probes that need a **live** credential; not part of `npm test` |
| `scripts/link-dev.mjs` | symlinks `node_modules` at an installed pi |

## Tests

```bash
npm run test          # wire-test.ts   -> 66 passed, 0 failed
npm run test:xxhash   # canonical XXH64 vectors, seed 0
npm run test:bun      # 836/836 match bun's native xxHash64  (needs bun)
npm run test:all      # all three
npm run typecheck     # tsc --noEmit, 0 errors
```

`wire-test.ts` starts a local HTTP server impersonating the Messages API, points
the provider at it with a fake OAuth token, and asserts that the outgoing
request carries the expected fingerprint — headers, betas, the 64k clamp,
system-block order, `cch` correctness (recomputed independently from the
transmitted bytes), tool prefixes and the cloaked user id. It also checks that
model-supplied headers cannot clobber enforced ones, and that the SSE response
parses into thinking/text/toolCall content with correct usage and cost. No
credentials and no network access required.

`compare-bun.ts` is the ground truth for the XXH64 port: 4 seeds × 209 inputs
diffed against bun's native implementation. `verify-xxhash.ts` is the bun-free
subset.

`diagnostics/*.ts` are one-off probes that need a **live** credential; they are
not part of `npm test`.

## Hard rules

1. **Do not change values in `fingerprint.ts` casually.** The `claude-cli`
   version string, `X-Stainless-*` values, beta list, 64k `max_tokens` clamp,
   `_` tool prefix, billing header and `cch` seed are transcribed from omp
   17.4.2 and pinned on purpose. Changing them can silently break subscription
   auth. `X-Stainless-OS`/`X-Stainless-Runtime-Version` are constants by design —
   do not make them host-derived (only `X-Stainless-Arch` is).
2. **Never advertise 1M-context betas on OAuth.** Subscription credentials have
   no long-context credit and Anthropic hard-429s.
3. **OAuth vs API key must stay divergent.** OAuth: clamp `max_tokens`, prefix
   tools, cloak `metadata.user_id`, relocate pi's system prompt into a leading
   `<system-reminder>` user turn. API-key requests keep the full ceiling and the
   prompt in `system`. Tests assert both paths.
4. **TypeScript style is constrained by `tsconfig.json`**: `erasableSyntaxOnly`
   (no enums, namespaces, parameter properties), `verbatimModuleSyntax`
   (`import type` for types), explicit `./foo.ts` import specifiers,
   `noUnusedLocals`/`noUnusedParameters`. Tabs for indentation.
5. **No `@ts-ignore` / `@ts-expect-error`.** The tree currently has zero; keep it
   that way.
6. **Zero runtime dependencies.** Only `typescript` and `@types/node` as
   devDependencies, `@earendil-works/*` as peers. Do not add runtime packages.

## Changing wire behaviour

Any change to the outgoing request must be covered in `wire-test.ts`, which
captures the raw body/headers on a local server and re-verifies `cch`
independently. Run `npm test` and `npm run typecheck` before finishing.

Live-credential experiments belong in `diagnostics/` as a new probe file, with a
header comment stating the hypothesis, the established facts and the run
command — follow the existing files' shape. Never commit tokens or captured
bodies.
