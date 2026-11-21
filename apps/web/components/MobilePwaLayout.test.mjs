import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const extensionStatusBarSource = await readFile(new URL("./ExtensionStatusBar.tsx", import.meta.url), "utf8");
const newSessionBarSource = await readFile(new URL("./NewSessionContextBar.tsx", import.meta.url), "utf8");

test("every class the keyboard-open rules target exists on its component", () => {
  // Every selector the keyboard rules target must exist on the element it
  // means; a renamed class would otherwise leave the rule silently dead.
  assert.match(chatInputSource, /className="chat-input-controls"/);
  assert.match(chatInputSource, /className=\{compact \? undefined : "chat-input-shell"\}/);
  assert.match(extensionStatusBarSource, /className=\{`extension-status-shelf/);
  assert.match(chatWindowSource, /className="chat-content /);
  assert.match(newSessionBarSource, /<div className="new-session-context">/);
});
