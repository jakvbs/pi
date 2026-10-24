# pi-auto-effort

Picks the thinking effort for each request, so you don't have to switch it by hand during a task.

Select an auto model, for example `/model pi-sub-anthropic/claude-opus-5-5-auto` or `--model pi-sub-anthropic/claude-opus-5-5-auto:high`. It answers with `claude-opus-5-5`, and the thinking level you select becomes the starting level:

- Every message you send starts at the selected level.
- The model's first response to each of your messages is only a `set_thinking_effort` call that picks the level for the task, so the work itself runs at that level. This costs one short extra request per message, which reads the conversation from the cache. A low selected level keeps that request cheap.
- Later in the task the model can change the level again, for example `low` while applying a planned edit and `xhigh` before debugging a failure. It does so together with the first tool call of the new phase, so these changes cost no extra request.
- Three consecutive turns with a failing tool call raise the level one step, up to the highest level the model supports. Each change needs a new streak of three.

Each change shows up in the transcript as an `[auto effort]` message, and the footer shows the level the request used next to the selected one.

Auto models exist for `claude-fable-5-1`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` under the `pi-sub-anthropic` and `anthropic` providers.

## Why changing the level keeps the prompt cache

These models take the effort as a marker inside the conversation (beta `mid-conversation-output-config-2026-07-01`) instead of a request setting, so the earlier part of the conversation stays cached when the level changes. A marker only applies after new input: after a turn of tool results alone it would wait for your next message. The `[auto effort]` message is that new input, so a change applies to the very next response. An auto model refuses to route to a model without marker support rather than drop the cache on every change.

A guideline that only allowed the model to raise the level at the start of a hard task was not enough: starting at `low`, the model never called the tool in four tasks, including writing and debugging code. With the mandatory first call it picked `low` for listing files and a domino-tiling count, `medium` for two small coding tasks, `high` for a number-theory proof and a race-condition fix the user called wrong before, and `xhigh` for designing a lock-free queue, using 79-89 output tokens for the choice.

Measured on `pi-sub-anthropic/claude-opus-5-5` (2026-10-25): after `set_thinking_effort` to `max` from a `low` start, the next request read the whole previous request from the cache (7938 tokens) and wrote 244 new ones, and its response used 1966 output tokens; three failing `bash` turns at `low` raised the level to `medium`, and every request read the previous one from the cache.

## Limits

- The list of auto models is fixed in `index.ts`. A model added to the catalog later needs an entry there.
- Every failing tool result counts, including `grep` or `rg` finding nothing (exit code 1).
- Only the model lowers the level during a task; the next message you send resets it.
- The level is the model's own judgment of the task, made at the selected level; nothing checks it against how the task goes except the failing-turn rule.
