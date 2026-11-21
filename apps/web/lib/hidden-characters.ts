// Characters that would make the text shown differ from the text it stands
// for, in a value a repository chose (a folder name, a path): controls (a
// newline can push the rest out of view), format characters (bidi overrides
// that reorder what follows, zero-width spaces, word joiners, tag characters),
// line and paragraph separators, variation selectors, the blank fillers Hangul
// and Braille define, and every space but U+0020, which CSS does not collapse
// and which reads as an ordinary space. Client-safe: no Node imports.
const HIDDEN_CHARACTERS =
  "\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000"
  + "\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}\\u115F\\u1160\\u3164\\uFFA0\\u2800";
const HIDDEN_CHARACTER = new RegExp(`[${HIDDEN_CHARACTERS}]`, "gu");

/**
 * `text` with each invisible, control or unusual space character replaced by
 * a visible `\u{XXXX}` escape. Not `\n` or `\t`: a Windows path such as
 * `C:\new\tools` is written with backslashes and must not read as escapes.
 */
export function revealHiddenCharacters(text: string): string {
  return text.replace(HIDDEN_CHARACTER, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\u{${code.toString(16).toUpperCase().padStart(4, "0")}}`;
  });
}
