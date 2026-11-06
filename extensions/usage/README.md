# pi-usage

Shows how much of the Claude and Codex subscription quotas is used, in Pi's interactive mode.

- Footer: `Claude 5h 12% 7d 81% reset 2h5m · Codex 7d 3%` - used percent per quota window. A window at 70% or more is highlighted and shows the time to its reset; at 90% it turns red, and a subscription whose limit is reached has its name in red. `?` means no value is known: the check failed and no session has saved one.
- `/usage`: checks again and lists every window with its reset time, or the error of a failed check and the age of the value kept instead.

Usage is read from the endpoints the official clients use for the same view, with the OAuth access token of the logged-in pi provider; no model request is made and nothing is billed:

| Subscription | pi provider | Endpoint |
| --- | --- | --- |
| Claude Pro/Max | `pi-sub-anthropic` | `GET https://api.anthropic.com/api/oauth/usage` |
| ChatGPT (Codex) | `openai-codex` | `GET https://chatgpt.com/backend-api/wham/usage` |

A subscription appears only when its provider has credentials (`/login`). Claude follows the `anthropic-ratelimit-unified-*` headers of its model responses; its endpoint is read at session start and by `/usage`. Codex is read at session start, after an agent run and every five minutes.

Every known value is saved to `~/.pi/agent/usage/<provider>.json`, which all sessions share. A session shows the saved value at start and skips its endpoint while the value is under five minutes old, so sessions started together make one request; after an agent run and every five minutes it takes a newer saved value, and Codex is read again once its value is 30 seconds old. A failed check keeps the last value.

## Limits

- Claude reports a window as `null` until it has usage, so an idle 5-hour window is not shown rather than shown as 0%.
- Codex windows are labelled by their length; a Pro plan currently has only a weekly window.
- Claude's endpoint answers HTTP 429 when several sessions poll it, so it is not polled. Usage from other devices shows only after a Claude response or `/usage`; an idle session sees other sessions' usage at its next check.
- Both endpoints are undocumented. A changed response shape shows as `?` in the footer and `no usage windows in the response` in `/usage`.

## Install and test

```bash
pi install ~/projects/pi/extensions/usage
cd ~/projects/pi/extensions/usage && npm test && npm run typecheck
```
