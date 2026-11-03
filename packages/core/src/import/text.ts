// The text of an import file (doc 02 section 13.1, doc 10 T13). A file is untrusted: every string that reaches a stored or an echoed field is made plain text first, which here means that
// control characters (the C0 and C1 ranges and DEL, so NUL and the line breaks too) are removed, a lone surrogate that no encoding can carry is replaced, and the ends are trimmed. Nothing
// is interpreted: markup stays the characters it is, and the clients render a title as text. A description is the one field that keeps a line break and a tab (`plainDescription`).

const CONTROL_CHARACTER = /\p{Cc}/gu;
const LINE_BREAK_VARIANT = /\r\n?/g;
const CONTROL_CHARACTER_BUT_LINE_BREAK_AND_TAB = /[^\P{Cc}\n\t]/gu;

/** `value` as plain text: no control character, well-formed, trimmed. */
export function plainText(value: string): string {
  return value.replace(CONTROL_CHARACTER, "").toWellFormed().trim();
}

/** `value` as the plain text of a description: `\r\n` and a lone `\r` become `\n`, `\n` and `\t` stay, every other control character is removed, well-formed, trimmed. */
export function plainDescription(value: string): string {
  return value.replace(LINE_BREAK_VARIANT, "\n").replace(CONTROL_CHARACTER_BUT_LINE_BREAK_AND_TAB, "").toWellFormed().trim();
}

/**
 * `value` cut to at most `max` code points, never inside a surrogate pair, and trimmed again where the cut leaves a space at the end. The scan stops at the cut, so a string of any length
 * costs no more than `max` steps once it is known to be longer.
 */
export function cutCodePoints(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  let end = 0;
  let count = 0;
  for (const character of value) {
    if (count === max) {
      break;
    }
    end += character.length;
    count += 1;
  }
  return value.slice(0, end).trimEnd();
}

/** Plain text cut to `max` code points. */
export function cleanText(value: string, max: number): string {
  return cutCodePoints(plainText(value), max);
}

/** A description as plain text cut to `max` code points. */
export function cleanDescription(value: string, max: number): string {
  return cutCodePoints(plainDescription(value), max);
}
