/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

/** How many presses of `app.tools.expand` reach the transcript level that expands every entry. */
let expandPresses = 1;

/** Set how many presses of `app.tools.expand` reach the transcript level that expands every entry. */
export function setExpandPresses(presses: number): void {
	expandPresses = presses;
}

/**
 * The keys that expand an entry which opens only at the transcript's expanded level, with the number of presses when
 * it takes more than one, for example `ctrl+o ×3`.
 */
export function expandKeyText(): string {
	const keys = keyText("app.tools.expand");
	return expandPresses > 1 ? `${keys} ×${expandPresses}` : keys;
}

/** {@link keyHint} for an entry which opens only at the transcript's expanded level. */
export function expandHint(description: string): string {
	return theme.fg("dim", expandKeyText()) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}
