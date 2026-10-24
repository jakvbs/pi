# pi-composer-predictions (prototype)

Completes the word being typed in the editor from the user's own prompt history. The rest of the word, or the
next word after a space, shows as dim ghost text after the cursor. Everything runs locally and sends nothing
to a model.

- Tab inserts the ghost and a space, so the next word's ghost follows at once. Right inserts the ghost alone.
  Both take only a ghost on screen; a ghost that does not fit, or starts with a wide character, is not painted.
- A ghost shows only when the model gives the word at least the confidence threshold (default 0.3), measured
  against every word under the typed prefix, the prefix itself included.
- A word shows from its second use. Half the words in the author's history were used once.
- A word with a run of 12 or more letters or digits that holds a digit never shows: hashes, UUIDs, tokens and API
  keys. Hyphenated names such as `gemini-3-pro-preview` or `claude-opus-4-5-20251101` still do.
- Each message sent from the editor is learned at once, also while the history is still loading.

```bash
pi -e extensions/composer-predictions
```

## Where the words come from

At the first session start of the process the extension reads, when present:

- `~/.pi/agent/pi-prompt-history-history.json`, the history kept by `@light4/pi-prompt-history`,
- `~/.claude/history.jsonl` (Claude Code), `~/.codex/history.jsonl` (Codex) and `~/.omp/agent/history.db`
  (oh-my-pi).

A source that cannot be read, such as a file in a changed format, is skipped with a warning naming it and the
reason, and the other sources still load. `/predict` lists the prompts read from each source and the sources not
read. Prompts longer than 2,000 characters, sent ones included, are skipped as pastes.

The model counts every word, and every word after one and after two given words, then mixes the three with
weights 0.4, 0.3 and 0.2. Words are lowercase letters and digits; an all-caps prefix gets an all-caps ghost.

The history loads in slices of 8 ms between turns of the event loop, so the editor takes keystrokes while it
loads, and ghosts appear once it is done. The model then stays for the life of the process: a session started
with `/new` reuses it, while `/reload` builds it again.

## Commands

- `/predict` shows the threshold, the history per source, how long it took to load and the longest event-loop
  delay meanwhile, and the usage log summed per threshold.
- `/predict on`, `/predict off`.
- `/predict 0.15`, `/predict 0.3`, `/predict 0.45` set the threshold.
- `/predict replay` types out the newest 400 one-line prompts letter by letter with a model trained on the
  prompts before them, and reports keystrokes saved and wrong ghosts per 100 words at each threshold.
  `npm run replay` prints the same for all sources and for pi's history alone.

The replay counts a typist who takes every right ghost with the cheaper key. Retypes that fix a typo in one of
the five prompts before them are skipped, since the earlier prompt predicts them almost whole.

## Usage log

Each message sent from the editor while completion is on and the history has loaded appends one line to
`~/.pi/agent/composer-predictions/usage.jsonl`. The line holds counts only, never the text: the time, the
threshold, the message's characters and words, the distinct ghosts painted, the ghosts taken, and the characters
they inserted. Every pi window appends to the same file.

`/predict` sums the log per threshold: keystrokes saved, counted like the replay as inserted characters less one
key per taken ghost, then ghosts taken of those shown, and ghosts not taken per 100 words. Unlike the replay, it
measures what was actually taken. Ghosts painted in a draft that was cleared without sending count toward the
next message.

## Limits

- Single-line drafts with the cursor at the end only, and only while the editor has focus.
- The editor is replaced by a `CustomEditor` subclass. Another extension calling `setEditorComponent`
  replaces it or is replaced by it, whichever runs later.
- The history and the model take about 70 MiB.
- Loading about 17,000 prompts took 1.1 to 5.5 s on the author's machine, depending on what else ran. Built in
  one go it held the event loop for about 0.9 s; in slices the longest delay was 28 to 120 ms, most of it a
  garbage-collection pause over the model's maps. During the load a keystroke echoed in a median of about 20 ms
  instead of 8.
- Prompts typed in another pi window, Claude Code, Codex or oh-my-pi reach the model at the next start.
- No dictionary: on the author's history a 100,000-word Polish and English frequency list changed the saved
  keystrokes by less than half a point.
