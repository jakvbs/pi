# pi-usage

Shows how much of the Claude and Codex subscription quotas is used, in Pi's interactive mode.

- Footer: `Claude 5h 12% 7d 81% ↻2h5m · Codex 7d 3%` - used percent per quota window. A window at 70% or more is highlighted and shows the time to its reset; at 90% it turns red, and a subscription whose limit is reached has its name in red. `?` means the last check failed.
- `/usage`: checks again and lists every window with its reset time, or the error of a failed check.

Usage is read from the endpoints the official clients use for the same view, with the OAuth access token of the logged-in pi provider; no model request is made and nothing is billed:

| Subscription | pi provider | Endpoint |
| --- | --- | --- |
| Claude Pro/Max | `pi-sub-anthropic` | `GET https://api.anthropic.com/api/oauth/usage` |
| ChatGPT (Codex) | `openai-codex` | `GET https://chatgpt.com/backend-api/wham/usage` |

A subscription appears only when its provider has credentials (`/login`). Usage is checked at session start, after an agent run (at most every 30 seconds) and every five minutes.

## Limits

- Claude reports a window as `null` until it has usage, so an idle 5-hour window is not shown rather than shown as 0%.
- Codex windows are labelled by their length; a Pro plan currently has only a weekly window.
- Both endpoints are undocumented. A changed response shape shows as `?` in the footer and `no usage windows in the response` in `/usage`.

## Install and test

```bash
pi install ~/projects/pi/extensions/usage
cd ~/projects/pi/extensions/usage && npm test && npm run typecheck
```
