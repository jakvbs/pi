import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { WordEditor } from "./editor.ts";

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const TAB = "\t";
const plain = (text: string) => text;

/** The editor reads only these two members of the TUI. */
const tui = { requestRender() {}, terminal: { rows: 24 } } as unknown as TUI;
/** pi's manager adds only loading from keybindings.json to the TUI one, which pi does not export as a value. */
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as ConstructorParameters<typeof WordEditor>[2];
const theme = {
	borderColor: plain,
	selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};

function painted(draft: string): WordEditor {
	const ghostFor = (text: string) => (text === "pu" ? { start: 0, rest: "shnij", confidence: 1 } : undefined);
	const editor = new WordEditor(tui, theme, keybindings, ghostFor, plain);
	editor.focused = true;
	editor.setText(draft);
	editor.render(40);
	return editor;
}

test("Tab takes the painted ghost with a space and Right without one", () => {
	const tab = painted("pu");
	tab.handleInput(TAB);
	assert.equal(tab.getText(), "pushnij ");
	const right = painted("pu");
	right.handleInput(RIGHT);
	assert.equal(right.getText(), "pushnij");
});

test("a key that moved the cursor before the next frame leaves the painted ghost out", () => {
	const right = painted("pu");
	right.handleInput(LEFT);
	right.handleInput(RIGHT);
	assert.equal(right.getText(), "pu");
	const tab = painted("pu");
	tab.handleInput(LEFT);
	tab.handleInput(TAB);
	assert.equal(tab.getText(), "pu");
});
