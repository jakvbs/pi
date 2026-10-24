# pi-timing

Shows how long agent runs take, and when each message was sent, in Pi's interactive mode.

- Footer: `● 0:42` - elapsed time of the current run, shown only while it runs. Finished runs show their
  duration in the transcript instead.
- Transcript: a dim right-aligned stamp under every user message (send time), under the last text block of
  every response (completion time) and, on the response that ends a run, the run duration:
  `14:35:10 · 2:37`. Days other than today also show the date.

A run lasts from the first user message after the previous final response to the response that ends it
(any stop reason except `toolUse` and `error`), so tool calls, retries and steering messages count toward
it. A run started by an extension message without a user message is measured from that message.

## Old sessions

Stamps are derived from timestamps Pi already stores: the user message time and the time each response
entry was appended. Sessions recorded before the extension was installed show the same stamps, and the
extension writes no session entries.

## Limits

Stamps are appended through `registerMarkdownTransformer`, the only extension hook that reaches built-in
user and assistant messages, so:

- A response without text (only thinking or tool calls) gets no stamp.
- In a response with several text blocks, the stamp is placed on the block equal to the last text block.
  If an earlier transformer (for example Mermaid rendering) rewrote that block, the response gets no stamp.
- Messages rendered live carry no session-entry id, so they are matched to their timestamps by text.

## Install and test

```bash
pi install ~/.repos/pi/extensions/timing
cd ~/.repos/pi/extensions/timing && npm test && npm run typecheck
```

It replaces `@carlosgtrz/pi-run-timer` (footer) and `@narumitw/pi-stamp` (transcript stamps), whose state
lives in session entries written while they run and therefore does not cover older sessions.
