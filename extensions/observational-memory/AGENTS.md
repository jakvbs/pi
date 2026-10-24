# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Origin

Copied into the pi monorepo at `extensions/observational-memory` from the `jakvbs/pi-observational-memory`
fork (branch `fix/omit-memory-thinking`, commit `25c63ea`) of `elpapi42/pi-observational-memory`, without
git history. It is a standalone package outside the root npm workspaces with no dependencies or lockfile of
its own: build, typecheck and tests use the monorepo root `node_modules` (`npm install` in the
root) and resolve `@earendil-works/*` to the fork's `packages/*/src` through the root `tsconfig.json` paths and
`vitest.base.ts` aliases. It is `private`, is not published, and no CI runs it. pi loads it by path from
`settings.json` `packages`. `UPSTREAM` (git config format) records the last imported upstream commit; newer
upstream commits are imported on top of it with `git am -3 --directory=extensions/observational-memory`.

## Model requests

Workers run each conversation through `runWorkerConversation` (`src/agents/worker-stream.ts`), which sends
every model request through Pi's `ModelRegistry.streamSimple`: it selects the provider (also one an
extension registered with its own stream), authenticates the request when it is sent, applies the session's
timeouts, provider retries, client identity and `before_provider_headers` handlers, and adds provider
routing such as OpenCode's session header from the per-conversation `sessionId`. Session-only parts stay
out: `before_provider_request`/`after_provider_response` hooks, the `transport` setting, cache warming. When the conversation ends it releases the provider resources Pi
keeps for that `sessionId` (`cleanupSessionResources`, e.g. a Codex WebSocket). Workers never hold an API key, headers or env, and
`Runtime.resolveModel` only chooses a model; a request Pi cannot authenticate fails like any model call
and takes the fallback retry. `tests/worker-requests-end-to-end.test.ts` drives a real Pi session with
the extension loaded against a local provider and covers a rotated credential, an extension-registered
OAuth provider, a logged-out primary with a fallback, and OpenCode routing.
Tests: `npm test` (vitest); typecheck: `npm run typecheck`.

## Fallback model (`fallbackModel`)

`config.fallbackModel` is a second memory-worker model. It is tried in two places:

- Resolution (`Runtime.resolveModel` → `resolveFallbackModel`): used when no primary memory model
  (config `model`, else session model) is available.
- Runtime (`runStage` of `makeModelResolver` in `src/worker-models.ts`): a worker stage that throws, including a
  request Pi cannot authenticate, is retried once with the fallback. Background consolidation and the
  compaction catch-up share this.

`makeModelResolver` caches the fallback for the rest of the pass once it resolves, and a stage whose
result already carries `fallbackUsed: true` is never retried again. Do not make the fallback mandatory: with none configured, the previous skip/fail-safe behavior
must be byte-for-byte unchanged (covered by `tests/runtime.test.ts` and `tests/consolidation-trigger.test.ts`).

## Prebuilt extension entry

`pi.extensions` loads the committed prebuilt module at `dist/index.ts`, so `src/` edits need
`npm run build` before committing. `npm run check` rebuilds the module, fails when `dist/` is stale, then
typechecks and runs the tests; no CI runs it, so run it before every commit here (a base branch that moved
and changed `src/` also needs a rebuild). The root `.gitignore` ignores `dist/`; the local `.gitignore`
re-includes it. Keep the output's `.ts`
extension and the host packages external — `scripts/build.js` explains why.

## Rules and enforcement

After a correction, fix the cause and update this table. A rule without enforcement that is broken again gets a mechanism in the same change. Drop a row once construction makes the mistake impossible.

| Rule | Enforcement |
| --- | --- |
| Memory workers append `om.*` entries only through `recordMemoryEntry`, passing the branch they read; it refuses the append once that branch's tip is off the current branch. | `readBranch` is a required parameter; `tests/ledger-writes.test.ts` fails on `appendEntry(` outside `src/memory-journal.ts`. |
| Workers hold no credentials and send model requests only through Pi's `ModelRegistry.streamSimple` (`runWorkerConversation`). | `tests/worker-credentials.test.ts` fails on `getApiKey*(` or a direct pi-ai stream import in `src/`; `tests/worker-requests-end-to-end.test.ts` checks the requests a real Pi session sends. |
| Code reads `om.*` entries only through `branchLedger` (`src/session-ledger/ledger.ts`): valid V3 data with a coverage marker on the branch. | The entry guards are private to `ledger.ts`; `tests/session-ledger-ledger.test.ts` checks that folds, projection, changelog, recall and coverage all ignore a sibling-branch entry. |
| A token clock's name starts with its unit: `raw*` (local estimate), `measured*`/`real*` (provider tokens). | None: naming judgment, stated in `src/session-ledger/progress.ts`. |
| A warning about a condition that can outlast a memory pass (a failing stage or primary model, a missing model) goes through `runtime.warnings` (`src/warnings.ts`): shown once while the condition holds, again after it cleared. Passes restart on every turn while a stage is due. | `tests/worker-requests-end-to-end.test.ts`: a stage that keeps failing and a primary that keeps failing behind a working fallback each warn once in a real Pi session. |
| Committed `dist/` matches `src/`. | `npm run check` (`git diff --exit-code -- dist`); no CI or hook runs it. |

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

<!-- opm:managed:start -->
- The user prefers narrow fixes that preserve unrelated improvements. For ambiguous semantics, the user wants options and tradeoffs first, then autonomous implementation, validation, and a focused pull request.
- Compaction, consolidation, and memory storage use separate token domains. `compactAfterTokens` measures source entries after the compaction boundary weighted in provider tokens (`measuredSourceTokens`: usage growth between consecutive assistant replies, local estimate where no usage brackets an entry), while observation and reflection scheduling take the larger of the raw estimate and a provider context delta. Pool, serialized-input, stored-memory, and output limits use local estimates. Changes to token accounting must align the trigger, status, documentation, and tests.
- Pi exposes aggregate active-context usage, not per-entry attribution. `measuredSourceTokens` derives it from consecutive assistant usages; a segment spanning a compaction or context edit has no valid baseline and keeps the character estimate.
- Memory activation (`src/hooks/activation.ts`) returns a compaction draft from Pi's actionable `turn_end` boundary; Pi persists it before the next model request, also mid tool loop. Its handlers chain: return `[...event.entries, draft]`, never a fresh list. The extension never calls `ctx.compact()`; `session_before_compact` only serves Pi's own threshold, overflow, and manual compactions.
- `firstKeptEntryId` is a retention boundary, not a zero-progress boundary. Retained source entries can already exceed `compactAfterTokens`, so cadence changes must test consecutive post-success turns and distinguish successful repetition from failed-attempt backoff.
- Compaction must never discard source entries observation coverage has not reached. Activation cuts through `resolveCompactionCut`, so it never passes the observer frontier, and folds through the latest coverage marker so an observer chunk straddling the cut is not lost; `session_before_compact` keeps Pi's cut and folds through the same coverage marker when coverage already passes it (both paths share `foldThroughEntryIdFor`), and otherwise either moves `firstKeptEntryId` back to the turn containing the first unobserved entry (folding through the coverage marker, within `compactionMaxRetainedTokens`) or postpones (`{ cancel: true }`); overflow recovery cuts at Pi's boundary with a gap notice. The hook never returns nothing, even on an exception: Pi would then run its native summarizer. Pi honors an extension-supplied `firstKeptEntryId`; keep it on a valid cut point (user/assistant message, never a tool result) so no tool result is orphaned. Observer/reflector due-checks take the larger of the raw uncovered backlog and the provider delta: the delta alone starves coverage that fell behind a compaction.
- `consolidateWhenIdle` moves worker launches to `agent_settled` and aborts in-flight runs on `agent_start` via `runtime.consolidationAbortController`; stages must check `wasAborted` before recording errors or notifying. Activation still works then: past 1.2× `compactAfterTokens` it observes the gap synchronously while Pi waits between requests.
- Workers write `om.*` entries only through `recordMemoryEntry` (`src/memory-journal.ts`), which derives the change from the branch (`memoryChangelog`) for the completion notification and the `memoryFile` mirror. `/om:log` renders the same changelog; keep it on the fold's first-valid-record-wins semantics.
- Compaction summary size is budgeted (`renderSummaryWithBudget`, `compactionSummaryMaxTokens`); `details` still carry the full projection. Before retaining/postponing, the hook runs the observer synchronously on the unobserved gap (`compaction-catch-up.ts`, `compactionCatchUpMaxChunks`), also before the first coverage marker, unless a background consolidation is in flight; it appends coverage per recorded chunk and re-resolves the cut from a fresh `getBranch()`.
- A moved cut has two boundaries: retention (`firstKeptEntryId`, persisted by Pi) and fold (`details.foldThroughEntryId`). `latestFullFoldBoundaryId` must use the fold boundary, or a later compaction re-applies a different set of drops/reflections. Coverage markers are positional claims: any worker that appends one must have read every source entry after the previous marker.
<!-- opm:managed:end -->
