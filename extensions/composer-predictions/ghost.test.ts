import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, renderFakeCursor } from "@earendil-works/pi-tui";
import { paintGhost } from "./ghost.ts";

test("ghost starts in the cursor cell and fills the padding without changing the line width", () => {
	const dim = (text: string) => `<${text}>`;
	const border = "────────";
	const line = `ab${CURSOR_MARKER}${renderFakeCursor(" ")}     `;
	assert.deepEqual(paintGhost([border, line, border], "cd", dim), [
		border,
		`ab${CURSOR_MARKER}${renderFakeCursor("<c>")}<d>    `,
		border,
	]);
	assert.deepEqual(paintGhost([line], "cdefghijk", dim), [`ab${CURSOR_MARKER}${renderFakeCursor("<c>")}<defg…>`]);
});

test("nothing is painted when the cursor is not at the end of a line or the ghost starts with a wide character", () => {
	const line = `ab${CURSOR_MARKER}${renderFakeCursor("c")}d    `;
	assert.equal(
		paintGhost([line], "xyz", (text) => text),
		undefined,
	);
	const end = `ab${CURSOR_MARKER}${renderFakeCursor(" ")}     `;
	assert.equal(
		paintGhost([end], "日本", (text) => text),
		undefined,
	);
	assert.equal(paintGhost([end], "xyz", (text) => text)?.[0], `ab${CURSOR_MARKER}${renderFakeCursor("x")}yz   `);
});
