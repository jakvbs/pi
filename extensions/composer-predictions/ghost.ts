import { CURSOR_MARKER, renderFakeCursor, visibleWidth } from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const EMPTY_CURSOR = CURSOR_MARKER + renderFakeCursor(" ");

/** `text` cut to `width` cells with an ellipsis. Unlike `truncateToWidth`, it adds no SGR reset, so the caller's style holds. */
function fitToWidth(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	let kept = "";
	let used = 0;
	for (const { segment } of graphemes.segment(text)) {
		const cells = visibleWidth(segment);
		if (used + cells > width - 1) break;
		kept += segment;
		used += cells;
	}
	return `${kept}…`;
}

/**
 * Paint `ghost` from the cursor cell over the trailing padding of the editor line whose cursor sits at the end.
 * The line keeps its width; a ghost longer than the free cells ends in an ellipsis.
 */
export function paintGhost(lines: readonly string[], ghost: string, dim: (text: string) => string): string[] {
	const index = lines.findIndex((line) => line.includes(EMPTY_CURSOR));
	if (index < 0) return [...lines];
	const line = lines[index]!;
	const start = line.indexOf(EMPTY_CURSOR);
	const after = line.slice(start + EMPTY_CURSOR.length);
	const spaces = /^ */.exec(after)![0].length;
	const room = spaces + 1;
	const shown = fitToWidth(ghost, room);
	const first = graphemes.segment(shown)[Symbol.iterator]().next().value?.segment ?? "";
	if (visibleWidth(first) !== 1) return [...lines];
	const rest = shown.slice(first.length);
	const painted = `${CURSOR_MARKER}${renderFakeCursor(dim(first))}${dim(rest)}${" ".repeat(room - visibleWidth(shown))}`;
	const result = [...lines];
	result[index] = line.slice(0, start) + painted + after.slice(spaces);
	return result;
}
