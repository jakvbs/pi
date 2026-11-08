# pi-runs

Adds the `run` tool. A run is one `scout-agent` working in the background on its own Git branch and worktree, with a record that survives session restarts.

- `start` takes a `label` and `task`, returns as soon as the agent starts, and wakes the launching session when the agent ends. An optional `prepare` command (for example `npm ci`) runs in a new worktree first and blocks `start` for up to 15 minutes.
- `list` shows runs and their states. `show` shows one run's details, commits, and latest report.
- `steer` sends a `message` to the agent. `stop` requests a stop. `resume` continues the agent with a `message` and records another attempt.

Actions that target a run take its `id` or a unique suffix. By default, `start` uses the session's checkout and creates `run/<id>` from its HEAD, so a session in a linked worktree branches from its own work. An explicit `branch` is created the same way when it does not exist; otherwise the run works on it and reuses its worktree.

## Record

Each run lives in `~/.local/state/pi/runs/<id>/`, or `$PI_RUNS_DIR/<id>/` when `PI_RUNS_DIR` is set. The folder contains:

- `run.json` holds the repository, base commit, branch, worktree path, agent, optional model, skills, attempts, outcomes, commits, and session path when known.
- `task.md` holds the task sent to the agent, including the ticket path when supplied.
- `report-<n>.md` holds the last assistant text for attempt `n`, starting at 1, when that text is available at settlement.
- `sessions/` stores the child sessions.
- `worktree/` holds the checkout unless the run reuses an existing worktree elsewhere.

## Settlement and crashes

Settlement copies an ended attempt's outcome, report when available, session path, and branch commits into the record. The extension checks for settlement on `subagent:async-complete`, at session start, and on every `list` or `show`. An already-settled attempt stays unchanged.

The check reads pi-subagents' `status.json` and checks the runner process, not the file's age. A live queued or running attempt stays `running`. A completed attempt becomes `done`, and a paused or stopped attempt becomes `stopped`. A queued or running attempt whose runner died becomes `failed`. Missing status becomes `lost`; other terminal states become `failed`.

## Dependency and limits

The [subagents extension](../subagents/docs/extension-api.md#in-process-event-bus-rpc) must be loaded in the launching session, with `scout-agent` available. `runs` uses its in-process RPC for `spawn`, `steer`, `stop`, and `resume`, and its completion event for settlement.

Only the launching session can resume a run. A durable record does not transfer that ownership to a new session. Background children do not get the `run` tool; the extension skips registration when `PI_SUBAGENT_CHILD=1`.

## Install and test

```bash
pi install ~/projects/pi/extensions/runs
cd ~/projects/pi/extensions/runs && npm test && npm run typecheck
```
