# Contributing

How to develop, test and release `pi-sub-anthropic`, for anyone changing the
code in this repository.

## Setup

```bash
npm install --ignore-scripts   # in the pi monorepo root; this package has no node_modules of its own
pi install "$PWD"              # from extensions/sub-anthropic; the path is recorded, nothing is copied
```

`npm run typecheck` checks against the fork's `packages/*/src` through the root
`tsconfig.json` paths, and `npm test` loads them through
`packages/coding-agent/src/experimental/source-resolver.ts`, so both see the pi
this extension runs on.

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
| `wire-test.ts` | assertions against a mock Anthropic HTTP server; no credentials, no network |
| `compare-bun.ts` / `verify-xxhash.ts` | XXH64 conformance (vs bun native / canonical vectors) |
| `diagnostics/*.ts` | one-off probes that need a **live** credential; not part of `npm test` |

## Tests

```bash
npm run test          # wire-test.ts   -> 0 failed
npm run test:xxhash   # canonical XXH64 vectors, seed 0
npm run test:bun      # 836/836 match bun's native xxHash64  (needs bun)
npm run test:all      # all three
npm run typecheck     # tsc --noEmit against the fork's packages/*/src, 0 errors
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
4. **TypeScript style is constrained by `tsconfig.json`**, which extends the
   monorepo root config: `erasableSyntaxOnly` (no enums, namespaces, parameter
   properties), `verbatimModuleSyntax` (`import type` for types), explicit
   `./foo.ts` import specifiers. Tabs for indentation.
5. **No `@ts-ignore` / `@ts-expect-error`.** The tree currently has zero; keep it
   that way.
6. **Zero dependencies of its own.** `@earendil-works/*` are peers. Typecheck
   and tests resolve them, `typescript` and `@types/node` from the monorepo root
   `node_modules` and the fork's `packages/*/src`. Do not add packages.

## Changing wire behaviour

Any change to the outgoing request must be covered in `wire-test.ts`, which
captures the raw body/headers on a local server and re-verifies `cch`
independently. Run `npm test` and `npm run typecheck` before finishing.

Live-credential experiments belong in `diagnostics/` as a new probe file, with a
header comment stating the hypothesis, the established facts and the run
command — follow the existing files' shape. Never commit tokens or captured
bodies.
