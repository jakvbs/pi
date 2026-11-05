# turn-handoff

While a turn runs, a small model writes its handoff: what the user wants, what the agent has done, and what it does next. Pi shows the three lines below the turn's fold row, so a person who looks at a long turn does not have to read every tool call. When a turn that had a handoff ends, the model writes one sentence on what the whole turn did, which follows the fold row's counts. A short turn gets no handoff and costs nothing.

Each handoff is a `turn-handoff` session entry (`TURN_HANDOFF_ENTRY_TYPE` in `@earendil-works/pi-coding-agent`): the session keeps it, `pi --view` and a resumed session show it, and the agent's model never sees it. Only interactive sessions get handoffs.

## Settings

The extension does nothing until a model is set. Settings come from the `turn-handoff` key of `~/.pi/agent/settings.json`, and a project's `.pi/settings.json` overrides them:

```json
{
  "turn-handoff": {
    "model": { "provider": "pi-sub-anthropic", "id": "claude-sonnet-5-5", "thinking": "off" },
    "everySeconds": 60,
    "everyToolCalls": 8
  }
}
```

A running turn gets a handoff at the end of a step once `everySeconds` have passed since the previous one (or since the turn started), or once the agent has made `everyToolCalls` tool calls since then. Only one request runs at a time; a failed request waits a full interval and its steps go into the next one. The request goes through pi's model registry, so it uses pi's credentials for the provider; `thinking` is a pi thinking level, and `off` sends none.

## How the model writes

The model gets the user's message, the previous handoff of the turn and the steps since, each part cut to a fixed length (`writer.ts`), and answers with one tool call. It writes in the language of the user's message and follows the writing rules of ASD-STE100 Simplified Technical English in that language: one topic per sentence, short sentences, active voice, simple words. ASD-STE100 itself defines English only; the rules it applies to other languages are the ones that do not depend on the English dictionary.

## Replay

`npm run replay -- --model provider/id [--judge provider/id] [--turns 6] [--lang pl|en|any] [session.jsonl ...]` replays recorded turns through the same tracker and prompt, and writes a report to a new directory under `$TMPDIR`: latency, tokens and cost per request, sentences over the STE word limits, handoffs not in the user's language, names that are not in the model's input, and, with `--judge`, a judge model's 1-5 scores for faithfulness, currency, usefulness and style. Without files it reads the newest sessions under `~/.pi/agent/sessions`, and it sends a turn only to the provider that answered it when it was recorded (`--provider`, by default the handoff model's).

## Verification

`npm run typecheck && npm test`.
