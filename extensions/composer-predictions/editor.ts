import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { paintGhost } from "./ghost.ts";
import type { Ghost } from "./words.ts";

export class WordEditor extends CustomEditor {
	private readonly keys: KeybindingsManager;
	private readonly ghostFor: (draft: string) => Ghost | undefined;
	private readonly dim: (text: string) => string;
	/** Render runs on every frame, the model only when the draft changes. */
	private cached: { draft: string; ghost: Ghost | undefined } | undefined;
	/**
	 * Tab and Right take only the ghost on screen, for the draft it was painted on. Keys can arrive before the next
	 * frame, so they also need the cursor still at the end, as `ghost` checks.
	 */
	private painted: { draft: string; ghost: Ghost } | undefined;
	/** Called on each frame with the painted ghost's start and whole word, a key that holds while that word is typed. */
	onShow: ((key: string) => void) | undefined;
	onAccept: ((inserted: string) => void) | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		ghostFor: (draft: string) => Ghost | undefined,
		dim: (text: string) => string,
	) {
		super(tui, theme, keybindings);
		this.keys = keybindings;
		this.ghostFor = ghostFor;
		this.dim = dim;
	}

	refresh(): void {
		this.cached = undefined;
		this.tui.requestRender();
	}

	private ghost(draft: string): Ghost | undefined {
		if (this.isShowingAutocomplete()) return undefined;
		if (draft.includes("\n") || this.getCursor().col !== draft.length) return undefined;
		if (this.cached?.draft !== draft) this.cached = { draft, ghost: this.ghostFor(draft) };
		return this.cached.ghost;
	}

	override handleInput(data: string): void {
		const draft = this.getText();
		const ghost = this.painted?.draft === draft && this.ghost(draft) ? this.painted.ghost : undefined;
		const tab = this.keys.matches(data, "tui.input.tab");
		if (ghost && (tab || this.keys.matches(data, "tui.editor.cursorRight"))) {
			const inserted = tab ? `${ghost.rest} ` : ghost.rest;
			this.insertTextAtCursor(inserted);
			this.onAccept?.(inserted);
			return;
		}
		super.handleInput(data);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const draft = this.getText();
		const ghost = this.ghost(draft);
		const painted = ghost && paintGhost(lines, ghost.rest, this.dim);
		this.painted = ghost && painted ? { draft, ghost } : undefined;
		if (!ghost || !painted) return lines;
		this.onShow?.(`${ghost.start}:${draft.slice(ghost.start)}${ghost.rest}`);
		return painted;
	}
}
