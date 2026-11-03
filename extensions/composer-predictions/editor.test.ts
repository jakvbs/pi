import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { WordEditor } from "./editor.ts";

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
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
	const ghostFor = (text: string) =>
		text.endsWith("pu") ? { start: text.length - 2, rest: "shnij", confidence: 1 } : undefined;
	const editor = new WordEditor(tui, theme, keybindings, ghostFor, plain);
	editor.focused = true;
	editor.setText(draft);
	editor.render(40);
	return editor;
}

/** The cursor ends the first line of "pu\nnext", and every draft has a ghost. */
function atEndOfEarlierLine(): WordEditor {
	const ghostFor = () => ({ start: 0, rest: "shnij", confidence: 1 });
	const editor = new WordEditor(tui, theme, keybindings, ghostFor, plain);
	editor.focused = true;
	editor.setText("pu\nnext");
	editor.handleInput(UP);
	assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
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

test("at the end of a multi-line draft Tab and Right take the ghost of the last line", () => {
	const tab = painted("first line\npu");
	tab.handleInput(TAB);
	assert.equal(tab.getText(), "first line\npushnij ");
	const right = painted("first line\npu");
	right.handleInput(RIGHT);
	assert.equal(right.getText(), "first line\npushnij");
});

test("at the end of an earlier line Right moves to the next line and Tab leaves the text", () => {
	const right = atEndOfEarlierLine();
	right.handleInput(RIGHT);
	assert.equal(right.getText(), "pu\nnext");
	assert.deepEqual(right.getCursor(), { line: 1, col: 0 });
	const tab = atEndOfEarlierLine();
	tab.handleInput(TAB);
	assert.equal(tab.getText(), "pu\nnext");
});
