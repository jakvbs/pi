# pi-auto-effort

Picks the thinking effort for each request, so you don't have to switch it by hand during a task.

Select an auto model, for example `/model pi-sub-anthropic/claude-opus-5-5-auto` or `--model pi-sub-anthropic/claude-opus-5-5-auto:high`. It answers with `claude-opus-5-5`, and the thinking level you select becomes the starting level:

- Every message you send starts at the selected level.
- The model can change the level for the rest of the task with the `set_thinking_effort` tool, for example `low` while applying a planned edit and `xhigh` before debugging a failure. It calls the tool together with the first tool call of the new phase, so a change costs no extra request.
- Three consecutive turns with a failing tool call raise the level one step, up to the highest level the model supports. Each change needs a new streak of three.

Each change shows up in the transcript as an `[auto effort]` message, and the footer shows the level the request used next to the selected one.

Auto models exist for `claude-fable-5-1`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` under the `pi-sub-anthropic` and `anthropic` providers.

## Why changing the level keeps the prompt cache

These models take the effort as a marker inside the conversation (beta `mid-conversation-output-config-2026-07-01`) instead of a request setting, so the earlier part of the conversation stays cached when the level changes. A marker only applies after new input: after a turn of tool results alone it would wait for your next message. The `[auto effort]` message is that new input, so a change applies to the very next response. An auto model refuses to route to a model without marker support rather than drop the cache on every change.

Measured on `pi-sub-anthropic/claude-opus-5-5` (2026-10-25): after `set_thinking_effort` to `max` from a `low` start, the next request read the whole previous request from the cache (7938 tokens) and wrote 244 new ones, and its response used 1966 output tokens; three failing `bash` turns at `low` raised the level to `medium`, and every request read the previous one from the cache.

## Limits

- The list of auto models is fixed in `index.ts`. A model added to the catalog later needs an entry there.
- Every failing tool result counts, including `grep` or `rg` finding nothing (exit code 1).
- Only the model lowers the level during a task; the next message you send resets it.
