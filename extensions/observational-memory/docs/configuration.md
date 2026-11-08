# Configuration

This page documents the current V3 configuration for `pi-observational-memory`.

V3 keeps the existing `observational-memory` settings namespace, but the setting names changed. Old V2 keys are not aliases; they are ignored. If you are upgrading, read [Migrating from V2](#migrating-from-v2).

## Where settings live

Pi reads settings from:

1. Global settings: `~/.pi/agent/settings.json`
2. Project settings: `<project>/.pi/settings.json`
3. Environment override: `PI_OBSERVATIONAL_MEMORY_PASSIVE`

Project settings override global settings. `PI_OBSERVATIONAL_MEMORY_PASSIVE` overrides only `passive` when set to a recognized value.

All extension-owned settings live under:

```json
{
  "observational-memory": {}
}
```

The extension loads config once for its runtime. After changing settings, restart Pi or reload the extension so the new values are picked up.

## Full V3 example

```json
{
  "observational-memory": {
    "observeAfterTokens": 10000,
    "reflectAfterTokens": 20000,
    "observerChunkMaxTokens": 60000,
    "compactAfterTokens": 81000,
    "observationsPoolMaxTokens": 20000,
    "observationsPoolTargetTokens": 10000,
    "agentMaxTurns": 16,
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    },
    "fallbackModel": {
      "provider": "opencode-go",
      "id": "deepseek-v4.1-flash",
      "thinking": "low"
    },
    "showWorkerNotifications": true,
    "memoryFile": false,
    "passive": false,
    "debugLog": false
  }
}
```

You can omit everything. Defaults work for ordinary sessions, and if `model` is unset the memory workers use the current session model.

## Settings reference

| Setting | Type | Default | What it controls |
| --- | ---: | ---: | --- |
| `observeAfterTokens` | positive integer | `10000` | Raw/source token threshold for observer runs. |
| `reflectAfterTokens` | positive integer | `20000` | Observed source tokens since the last reflector pass at which the reflector runs again. |
| `observerChunkMaxTokens` | positive integer | derived; minimum `256` | Maximum estimated tokens sent to one observer run. Unset: 20% of the resolved memory model's context window, or `60000` when unknown. |
| `compactAfterTokens` | positive integer | `81000` | Activation threshold: the whole context Pi reports, with the system prompt, tool schemas, memory summary and history. Reaching it at `turn_end` replaces the observed part of the history with memory and keeps the newest ~20% of the threshold raw. |
| `compactionMaxRetainedTokens` | positive integer | derived | Maximum estimated source tokens the compaction hook may keep in context when it retains entries the observer has not reached yet. Unset: half of the active session model's context window, or `60000` when unknown. |
| `observationsPoolMaxTokens` | positive integer | `20000` | Active observation tokens at which the reflector runs before `reflectAfterTokens` arrived. |
| `observationsPoolTargetTokens` | positive integer below max | half of `observationsPoolMaxTokens` | Active observation tokens the reflector drops toward. A pass drops nothing while the pool is within it. |
| `agentMaxTurns` | positive integer | `16` | Shared nested-agent turn cap for the observer and the reflector. |
| `agentMaxTokens` | positive integer | `32000` | Maximum output tokens requested for memory-agent loops. Clamped to the model's own `maxTokens` when available. Lower it for local servers with a modest context window. |
| `model` | object | unset | Optional model override for observer and reflector. |
| `model.provider` | string | unset | Provider name in Pi's model registry. Required when `model` is set. |
| `model.id` | string | unset | Model id in Pi's model registry. Required when `model` is set. |
| `model.thinking` | enum | unset; workers fall back to `low` | Optional reasoning/thinking level for memory workers. |
| `compactionSummaryMaxTokens` | positive integer | derived | Estimated token budget for the memory summary the compaction hook renders. Unset: one eighth of the session model's context window, or `8000` when unknown. Observations get at least half (newest first); reflections take the rest. |
| `compactionCatchUpMaxChunks` | non-negative integer | `2` | Observer chunks the compaction hook may run synchronously to cover source entries the background observer has not reached before Pi's cut. `0` disables. |
| `workerMemoryMaxTokens` | positive integer | derived | Estimated token budget for the prior memory each observer and reflector request carries. Unset: a quarter of the memory model's context window, or `16000` when unknown. |
| `consolidateWhenIdle` | boolean | `false` | Run memory workers only while the agent is idle (launch from `agent_settled`, abort when a new agent run starts). For hosts where the session model and the memory model share one context budget. |

| `fallbackModel` | object | unset | Optional model the memory workers fall back to when the primary memory model fails to resolve or a worker call errors. |
| `fallbackModel.provider` | string | unset | Provider name in Pi's model registry. Required when `fallbackModel` is set. |
| `fallbackModel.id` | string | unset | Model id in Pi's model registry. Required when `fallbackModel` is set. |
| `fallbackModel.thinking` | enum | unset; falls back to `model.thinking` then `low` | Optional reasoning/thinking level used when the fallback is active. |
| `showWorkerNotifications` | boolean | `true` | Shows routine observer and reflector progress notifications, including what each finished run added or dropped. |
| `memoryFile` | boolean | `false` | Mirrors each session's memory to a markdown file under Pi's agent directory, rewritten after every memory change. |
| `passive` | boolean | `false` | Disables proactive background memory and memory activation. |
| `debugLog` | boolean | `false` | Writes best-effort per-session extension debug events to Pi's agent directory. |

Valid `model.thinking` values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Invalid values are ignored. Positive-integer settings must be finite integers greater than zero. `observationsPoolTargetTokens` must also be below `observationsPoolMaxTokens`; if omitted or invalid, it is derived as `Math.floor(observationsPoolMaxTokens / 2)`.

## `observeAfterTokens`

Default: `10000`.

The observer runs from Pi's `turn_end` hook. It counts raw/source tokens after the latest `om.observations.recorded.data.coversUpToId` marker. When the count reaches `observeAfterTokens`, the observer receives source entries after that marker and may append a non-empty `om.observations.recorded` ledger entry.

When Pi reports provider context usage, the observer is also due once the real context has grown by `observeAfterTokens` since the coverage marker (or since the latest compaction, when coverage is behind it). Either measure reaching the threshold launches the observer: the provider delta catches content the character heuristic undercounts, and the raw backlog keeps an observer that fell behind several compactions from starving on a small context window that Pi compacts every few thousand tokens.

Lower values create smaller chunks and more frequent model calls. Higher values reduce model-call frequency but let unobserved raw conversation accumulate longer. If the observer deliberately emits no observations, no ledger entry is written; the same range remains uncovered, and the observer retries after another `observeAfterTokens` of source tokens accumulate.

## `observerChunkMaxTokens`

Default: derived as 20% of the resolved memory model's context window, or `60000` when that window is unavailable.

This caps the source-addressed text sent to one observer run. Complete source entries are added oldest-first while they fit; remaining entries stay eligible for later runs. If the oldest entry alone exceeds the budget, the observer receives a clearly marked head/tail excerpt instead of an over-context request. The original session entry is not modified, and observations still cite its original source id so the source remains traceable in the session ledger.

Set an explicit value when a provider exposes a context window that differs from Pi's model metadata. Values below `256` are clamped to `256` so a chunk can always carry a complete source label, omission marker, and useful context. Keep room for the observer system prompt, prior observations/reflections, tool schemas, and output; setting this equal to the full model window will usually fail.

## `reflectAfterTokens`

Default: `20000`.

The reflector runs once this many source tokens arrived since the latest reflector pass. It counts source entries between the pass's coverage marker (the latest `om.reflections.recorded` or `om.observations.dropped`, whichever reaches further) and the latest observation coverage marker: material the observer has already turned into observations. Source the observer has not reached yet does not count, so an observer draining a large backlog in small chunks does not trigger a reflector pass after every chunk. When Pi reports provider context usage, real context growth of `reflectAfterTokens` since the pass marker also makes the reflector due. The reflector runs only when the observer recorded observations no pass has read.

A pass always looks for new reflections. It drops observations only while the active pool is over `observationsPoolTargetTokens`; within the target it only reflects. A pass that changes nothing waits for another `reflectAfterTokens` in that session.

Lower values distill reflections more often. Higher values reduce reflector model calls.

## `compactAfterTokens`

Default: `81000`.

Memory activation runs from Pi's actionable `turn_end` boundary, after every model turn, including the turns between tool calls of one agent run. It compares the threshold with the context Pi reports (`ctx.getContextUsage()`), the same number Pi shows in the footer and compacts on: the latest assistant usage plus an estimate of the entries after it. It includes the system prompt, tool schemas, the memory summary and the retained history. Right after a compaction the context is unknown until the next reply, and activation waits. Turns that were aborted or ended in an error do not activate.

The cut is sized in source entries after the latest compaction boundary, counted in provider tokens: every assistant reply carries the provider's context usage, and the growth between two consecutive replies is the size of the entries between them, spread in proportion to the local estimate. Entries without a usable bracket (before the first reply, across a compaction or context edit, after the latest reply, or where the reported context shrank) keep the local 4-characters estimate.

When the context reaches `compactAfterTokens`, the handler returns a compaction entry that Pi persists before the next model request:

- The cut keeps the newest ~20% of the threshold as raw history (Mastra's `bufferActivation: 0.8`), on a valid cut point so no tool result loses its call.
- The context after the cut, estimated as the reported context minus the source tokens the cut removes, must leave at least ~20% of the threshold free. Otherwise activation waits: when the system prompt, tools and memory alone nearly fill the threshold, a cut would fold a sliver and fire again a turn later. The context then grows until the observer catches up or Pi's own compaction runs. This share is fixed by the extension and does not follow `compaction.keepRecentTokens`; with `debugLog` on, the `activation.waiting` entry records `keptShareTokens`, `contextAfterCut`, `limitAfterCut` and `shortfallTokens`.
- The cut never passes the first source entry the observer has not reached. When the observer is behind, activation folds what it has covered and keeps the rest in context.
- When the history kept after the cut would still be at least 1.2× the threshold (Mastra's `blockAfter`), activation first waits for an in-flight observer run, then observes the gap synchronously (up to `compactionCatchUpMaxChunks` chunks), and cuts again.
- The summary folds every recorded observation, including a chunk that straddles the cut, rendered within `compactionSummaryMaxTokens`. Activation with no memory record to render waits for the observer instead.

Activation does not call `ctx.compact()` and never reaches Pi's native summarizer. Pi's own window-pressure compaction, overflow recovery, and manual `/compact` still go through `session_before_compact`. See [`compactionMaxRetainedTokens`](#compactionmaxretainedtokens) for how the hook protects unobserved context in those cases.

Every activation is a compaction entry, so Pi's TUI redraws the transcript from the retained history each time. A small threshold keeps the model's context small and the transcript short, but it must leave room above the system prompt, tool schemas and memory summary: activation needs them to take less than ~60% of the threshold.

## `compactionMaxRetainedTokens`

Default: derived — `floor(contextWindow * 0.5)` of the active session model, or `60000` when the context window is unknown.

Pi picks the retention boundary (`firstKeptEntryId`) from its own `keepRecentTokens` budget without knowing how far the observer has progressed. When the observer is behind that boundary, every source entry between the observation frontier and Pi's cut would be discarded with no observation describing it. In `session_before_compact` the hook therefore checks for such a gap and, when it finds one:

1. Moves the retention boundary back to the nearest valid cut point at or before the first unobserved entry (that entry itself, or the assistant message whose tool result it is), so those entries stay in context until the observer reaches them. All recorded observations are folded into the summary; a retained entry that already has an observation is redundant, never lost.

2. Checks that the estimated source tokens kept this way, plus the rendered memory summary that replaces the folded range, stay within `compactionMaxRetainedTokens`. If they would exceed it, or if the moved boundary would free nothing, or if there is no observation coverage at all, the hook postpones a manual or threshold compaction (`{ cancel: true }`) until the observer catches up. Overflow recovery never retains more than Pi asked for: it cuts at Pi's proposed boundary, folds all memory before it, and ends the summary with a notice naming the unobserved entries. They stay in the session file after the coverage marker, so the background observer still records them and a later compaction carries them. Keep this budget below Pi's own compaction threshold (`contextWindow - reserveTokens`), otherwise Pi compacts again immediately after a hook-owned compaction.

When the observer has already passed Pi's cut, the hook keeps Pi's boundary and folds through the latest coverage marker: that observer chunk straddles the cut and also describes the discarded entries before it.

The hook never hands a compaction to Pi's native LLM summarizer: it returns a memory compaction or postpones. An exception inside the hook postpones too (overflow recovery cuts at Pi's boundary with a notice instead), because Pi treats an extension that throws as one that returned nothing and would run its own summarizer. Keep Pi's own `compaction.enabled` on: it is what triggers threshold compaction and overflow recovery.

Set this explicitly when the session model advertises a context window that is much larger than the range it can attend to, or when Pi's `reserveTokens` leaves less than half the window for retained context.

## `observationsPoolMaxTokens`

Default: `20000`.

The reflector also runs once the active observation pool reaches this many tokens, before its `reflectAfterTokens` clock is due: every observation recorded on the branch and not dropped, counted as the line the reflector sees (id, timestamp, relevance, and content). It runs from the same consolidation pass as the observer, after it, so a new observer chunk can make it due at once. Since the limit is above `observationsPoolTargetTokens`, such a pass records new reflections and drops observations toward the target.

A pass that leaves the pool at or above the limit does not run again until the observer records more observations.

The next compaction shows the pass result. A compaction whose fold reaches a reflector result that the latest full fold did not apply is a full fold: it applies observations, reflections, and drops by coverage marker. Any other compaction keeps the reflections and drops of the latest full fold and appends only new observations, so the start of the summary stays stable for prompt caching.

## `observationsPoolTargetTokens`

Default: half of `observationsPoolMaxTokens`.

The reflector drops observations toward this target. While the pool is at or below it, a pass only records reflections and the model gets no drop tool. Over the target, it computes how many tokens the pool is over the target, converts that excess to an approximate observation count using the average active observation size, and passes that count to the model as a hard upper bound. The model may drop fewer or none. Code rejects unknown and duplicate ids and keeps at most that many drops, preferring stronger reflection coverage, then lower relevance, then older observations.

With the defaults, a pass drops observations only while the pool is over about `10000` tokens, and a pool that reaches about `20000` tokens runs the reflector before its `reflectAfterTokens` clock is due.

The reflector sees deterministic reflection coverage evidence for every active observation: `none` means no current reflection supports the observation id, `partial` means one reflection supports it, and `strong` means two or more reflections support it. Reflections recorded earlier in the same pass count. Coverage is evidence for the model, not an automatic drop rule. Relevance is importance/resistance rather than an absolute lock: `critical` observations require the strongest evidence, but older covered/superseded critical observations may leave active memory when semantic safety is clear. Dropping does not delete ledger history; known ids remain recallable.

## `agentMaxTurns`

Default: `16`.

This is the shared nested-agent turn cap for the observer and reflector. A turn is one assistant/model response cycle inside Pi's agent loop. The cap is not a token budget and not a literal tool-call counter.

Use lower values to bound background memory-worker cost. Too low can reduce observation coverage or reflection/drop quality.

## `agentMaxTokens`

Default: `32000`.

This is the maximum number of output tokens the extension requests for each memory-agent loop (observer, reflector). It is always clamped to the model's own `maxTokens` when the model advertises one.

Lower it when the memory model is a local server with a modest context window (for example, a llama.cpp server with a 64K slot). Slot KV is shared between the main session's retained cache and concurrent sub-agent requests, so a request whose combined input and response budget exceeds the window fails with `500 "Context size has been exceeded."` and the affected memory run aborts. Pairing a smaller `agentMaxTokens` (e.g. `8192`) with a low `observerChunkMaxTokens` keeps sub-agent requests inside the window.

## `model`

Default: unset, meaning memory workers use the session model.

Set `model` when you want the observer and reflector to use a cheaper or faster model than the main coding agent:

```json
{
  "observational-memory": {
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    }
  }
}
```

`provider` and `id` must both be non-empty strings. `thinking` is optional. If the configured model cannot be resolved, the runtime attempts to fall back to the current session model and notifies once. Memory workers send their requests through Pi, which authenticates each request when it is sent, so any model Pi can call works, including OAuth logins and providers registered by other extensions. If no model is available or Pi cannot authenticate the request, the relevant background worker skips/fails safely rather than inventing memory.

Workers stream through Pi's composed provider runtime, not `@earendil-works/pi-ai/compat` alone. Session models whose `api` id comes from `pi.registerProvider` (`cursor-sdk`, CLIProxyAPI, commandcode, and other custom APIs) work without a second built-in provider. `model` remains optional: set it only when you want cheaper/faster workers than the coding agent. Leaving it unset is the Cursor-only setup.

## `compactionSummaryMaxTokens`

Default: derived — `floor(contextWindow / 8)` of the active session model, or `8000` when the context window is unknown.

The rendered memory summary replaces the compacted range in context, so its size decides how much room is left before Pi's next compaction. Without a budget it grows with the ledger: on a long session it reached 17k tokens on a 64k window, more than the context it replaced. The hook reserves at least half of the budget for the newest observations (the chronological record), gives reflections the rest (newest first), lets each side reclaim what the other leaves unused, and ends the summary with a line stating how many older records were omitted. A record too large for the remaining budget is skipped rather than ending the selection, so a long newest record does not hide shorter older ones. If no record fits at all, the hook postpones the compaction (overflow recovery cuts with a notice instead) rather than writing a summary with instructions and no facts. Omitted records stay in the session ledger, count toward the full memory in `/om:status`, and are shown by `/om:view full`.

## `compactionCatchUpMaxChunks`

Default: `2`. Set `0` to disable.

When the background observer is behind Pi's proposed cut, retaining the unobserved tail costs headroom and postponing costs a compaction. Instead, the hook first observes the gap synchronously, up to this many observer chunks, appending coverage for each recorded chunk, and then re-resolves the cut, usually landing on Pi's proposed boundary with a bounded summary.

This runs inside `session_before_compact`, where Pi waits for the hook and no session request is in flight, so the memory model does not compete with the session even when both share one server. A chunk that records nothing, fails, or is aborted stops the catch-up; the remaining gap is retained or postponed as before, and nothing is appended for a failed chunk. Catch-up reads from the global observation frontier, not from the start of the retained range: a coverage marker claims every source entry before it, so unread source between the frontier and an earlier compaction boundary is included in the catch-up input rather than silently marked as observed. Catch-up is skipped while a background consolidation run is in flight. It also runs before the first coverage marker exists, so an empty memory is bootstrapped instead of postponing the compaction.

## `workerMemoryMaxTokens`

Default: derived — `floor(contextWindow / 4)` of the resolved memory model, or `16000` when the context window is unknown.

Each observer and reflector request carries prior memory so the worker does not repeat itself and can relate new material to old. The ledger grows without limit on long sessions (107 reflections and 121 active observations, about 45k tokens, on one multi-day session), and sending all of it made every worker request exceed a 64k window, which in turn kept the ledger from ever shrinking. Worker prompts now carry a bounded slice: observations get at least half the budget and reflections the rest, newest first, each side reclaiming what the other leaves. The reflector receives the oldest observations that fit instead, since it condenses and drops old records first. With the observer chunk capped at a fifth of the window and `agentMaxTokens` as the output reservation, a worker request stays inside the window.

## `consolidateWhenIdle`

Default: `false`.

By default the observer and reflector launch from Pi's `agent_start` and `turn_end` hooks, so they run concurrently with the session's own model calls. That is fine when the memory model has its own capacity. It breaks down when both share one context budget, such as a single local llama.cpp server whose slots draw from one KV pool: a worker request carrying the whole memory plus its output reservation, arriving while the session's request is in flight, exceeds the pool and one side fails with a context-size error — sometimes the session's turn.

With `consolidateWhenIdle: true`:

- Workers launch only from `agent_settled`, after the agent has finished a run and Pi is idle, so their requests never overlap the session's.
- When a new agent run starts while a worker is still running, the run is aborted. Coverage markers are appended only on success, so an aborted run leaves the ledger untouched and retries after the next settled event.

The trade-off is that during a long autonomous tool loop the background observer does not advance. Activation then observes the gap synchronously once the history reaches 1.2× `compactAfterTokens`, while Pi waits between model requests, so worker and session requests still never overlap. Memory catches up while you type.

## `fallbackModel`

Default: unset, meaning there is no fallback and a failed memory model behaves exactly as before (the worker skips or fails safely).

Set `fallbackModel` to give the memory workers a second model when the primary one is unavailable:

```json
{
  "observational-memory": {
    "model": {
      "provider": "anthropic",
      "id": "claude-haiku-4-5-20251001",
      "thinking": "low"
    },
    "fallbackModel": {
      "provider": "opencode-go",
      "id": "deepseek-v4.1-flash",
      "thinking": "low"
    }
  }
}
```

The fallback is tried in two places:

1. **Resolution.** When no primary memory model is available, the fallback is resolved and used. The notification names both the primary failure and the fallback that took over.
2. **Runtime.** When a worker stage (observer or reflector) errors during its model call, including when Pi cannot authenticate the primary (for example after a logout), that one stage is retried once with the fallback model. The observer run during compaction catch-up is retried the same way. The retry is per-stage and per-pass and is logged. A failing primary is notified once per stage, and again only after that stage's primary call succeeded in between.

Once the fallback resolves, it is reused for the rest of the consolidation pass, so later stages do not re-pay a known-broken primary. If the primary model itself resolved through the fallback, no further runtime retry is attempted for that pass.

If the fallback advertises a smaller context window than the primary, the observer chunk is capped to the smaller window before the run, so a fallback retry is never handed a prompt sized only for a larger primary. `fallbackModel.thinking`, when set, is the thinking level used for the fallback call.

`provider` and `id` must both be non-empty strings, exactly as for `model`. A `fallbackModel` identical to the effective primary memory model — the configured `model` when it resolves, otherwise the session model — is rejected as a misconfiguration. A fallback that also fails leaves the existing skip/fail-safe behavior intact: no memory is invented, coverage does not advance, and the failure is surfaced (worker failure notification, `/om:status`, debug log). Because coverage does not advance, the stage stays due and runs again after the next turn; there is no backoff between attempts.

## `showWorkerNotifications`

Default: `true`.

When `true`, every finished worker run that changed memory reports it, for example:

```txt
Observational memory: reflector −12 observations
  • User prefers Polish prose in docs
  • …
```

When `false`, the extension hides routine observer and reflector progress notifications (including deliberate-empty observer info messages). Model fallback/unavailability, worker failures (including observer stream errors), compaction notifications, and explicit `/om:*` command output remain visible. Memory passes restart after every turn while a stage is due, so a warning about a lasting condition (a failing stage, a failing primary model, a missing model) is shown once and again only after the condition cleared; `/om:status` shows the latest stage errors in between.

## `memoryFile`

Default: `false`.

When `true`, the extension keeps a markdown copy of each session's memory under Pi's agent directory:

```txt
observational-memory/memory/<session-id>.md
```

The file lists the project, the session file, the latest memory change, and the current reflections and active observations. It holds no history: `/om:log full` lists every change, including the content of dropped observations. It is rewritten after every observer and reflector entry, and when Pi starts, resumes, or navigates to another branch, so it always shows the current branch. A rewrite with no new change leaves the bytes unchanged, and the file is replaced by rename, so an editor or `watch` never sees a half-written file. Sessions without memory get no file.

The file is a view, not a store: the extension never reads it, and deleting it loses nothing. To keep a history outside Pi, put the directory under git and commit on every change (for example from an `inotifywait` loop); each diff then adds new observations and reflections and removes dropped ones.

## `passive`

Default: `false`.

When `true`, the extension does not proactively run the observer, the reflector, or memory activation. Manual/Pi compaction hooks, `/om:status`, `/om:view`, and `recall` remain available.

Environment override:

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=true pi
```

Truthy values: `1`, `true`, `yes`, `on`.

Falsy values: `0`, `false`, `no`, `off`.

Unrecognized values are ignored.

## `debugLog`

Default: `false`.

When enabled, the extension writes best-effort NDJSON debug events under Pi's agent directory. Normal Pi sessions write to a per-session file:

```txt
observational-memory/debug/<session-id>.ndjson
```

Contexts without a usable session id fall back to the legacy global file:

```txt
observational-memory/debug.ndjson
```

Each row includes event metadata such as `sessionId`, `sessionFile`, `runId`, `cwd`, and event-specific `data`. `runId` identifies one consolidation pipeline inside a session file, so you can filter a session log to a single observer/reflector pass.

Reflector diagnostics are especially useful when the active observation pool stays over its limit but no reflections or drops are appended. For example:

```bash
grep '"event":"reflector' ~/.pi/agent/observational-memory/debug/<session-id>.ndjson | tail -n 50
```

Look for `reflector.result`: `no_tool_call` means the model chose to change nothing, `all_filtered` means every proposed reflection and drop was unusable, and `accepted_nonempty` means the pass kept reflections or drops before append handling. `reflector.empty` marks the backoff until another `reflectAfterTokens` arrives.

Debug logs are opt-in local debugging artifacts. By default, diagnostic events should record aggregate counts, token totals, ids, file paths, errors, and project details rather than observation/reflection content, prompts, model responses, or raw model-proposed drop ids. Treat debug files as sensitive local artifacts.

Debug-log write failures do not change memory behavior.

## Migrating from V2

V3 is not backwards compatible with V2 settings. Old keys are silently ignored and do not act as aliases.

| V2 setting | V3 setting | Migration note |
| --- | --- | --- |
| `observationThresholdTokens` | `observeAfterTokens` | Rename. Same rough observer-cadence role. |
| `compactionThresholdTokens` | `compactAfterTokens` | Rename. Same rough role: memory activation cadence. |
| `reflectionThresholdTokens` | `reflectAfterTokens`, `observationsPoolMaxTokens`, and/or `observationsPoolTargetTokens` | Split. Use `reflectAfterTokens` for reflector cadence, `observationsPoolMaxTokens` for an earlier reflector run when the active pool grows, and `observationsPoolTargetTokens` for how far the reflector drops. |
| `compactionModel` | `model` | Move `{ provider, id }` under `model`. |
| `thinkingLevel` | `model.thinking` | Move under `model`. |
| `observerMaxTurnsPerRun` | `agentMaxTurns` | Replace with one shared cap. |
| `reflectorMaxTurnsPerPass` | `agentMaxTurns` | Replace with one shared cap. |
| `prunerMaxTurnsPerPass` | `agentMaxTurns` | Replace with one shared cap; V3's reflector also drops. |
| `compactionMaxToolCalls` | none | Remove. No V3 replacement. |
| `passive` | `passive` | Keep if desired. |
| `debugLog` | `debugLog` | Keep if desired. |

Old V2 memory entries and old V2 compaction details are ignored by V3. Start a new clean Pi session after upgrading to V3 so old visible summaries and old memory formats do not confuse the transition.

## Tuning recipes

### Lower background cost

```json
{
  "observational-memory": {
    "observeAfterTokens": 20000,
    "reflectAfterTokens": 50000,
    "observationsPoolMaxTokens": 40000,
    "agentMaxTurns": 8,
    "model": { "provider": "openrouter", "id": "a-cheaper-model", "thinking": "off" }
  }
}
```

Tradeoff: fewer background model calls, but memory updates lag longer, observation chunks are larger, and reflection/drop cleanup happens less often.

### More responsive memory

```json
{
  "observational-memory": {
    "observeAfterTokens": 750,
    "reflectAfterTokens": 3000,
    "observationsPoolMaxTokens": 6000,
    "agentMaxTurns": 16,
    "model": { "provider": "openrouter", "id": "a-fast-model", "thinking": "low" }
  }
}
```

Tradeoff: more background model calls.

### Disable proactive work temporarily

```json
{
  "observational-memory": {
    "passive": true
  }
}
```

Or for one shell:

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=1 pi
```

## See also

- [concepts.md](concepts.md) — vocabulary and mental model.
- [how-it-works.md](how-it-works.md) — lifecycle and data shapes.
- [../README.md](../README.md) — quick start and V2 migration summary.
