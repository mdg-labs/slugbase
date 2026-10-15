import type { PasswordScore } from "@slugbase/ui/patterns";

/** The shortest password the server accepts (doc 02 section 2.5); a shorter one never scores above "weak". */
const MIN_LENGTH = 12;

const COMMON_WORDS = [
  "password",
  "passwort",
  "letmein",
  "welcome",
  "willkommen",
  "admin",
  "administrator",
  "login",
  "qwerty",
  "qwertz",
  "iloveyou",
  "monkey",
  "dragon",
  "master",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "shadow",
  "superman",
  "trustno",
  "changeme",
  "secret",
  "bookmark",
  "bookmarks",
  "slugbase",
  "hallo",
  "geheim",
  "sommer",
  "winter",
  "summer",
  "spring",
  "autumn",
] as const;

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "qwertzuiop", "yxcvbnm", "1234567890"] as const;

/** Bits a dictionary word is worth to a guesser: a pick from a short list, whatever its length. */
const WORD_BITS = 11;
/** Bits a character that continues a repeat, a run or a keyboard walk is worth. */
const PREDICTABLE_BITS = 1;
/** Bits an entire password made of a common word, with digits or symbols around it, is worth at most. */
const COMMON_PASSWORD_BITS = 12;

const LEET: Readonly<Record<string, string>> = { "@": "a", "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", $: "s", "!": "i", "7": "t" };

function poolSize(chars: readonly string[]): number {
  let pool = 0;
  if (chars.some((char) => /\p{Ll}/u.test(char))) {
    pool += 26;
  }
  if (chars.some((char) => /\p{Lu}/u.test(char))) {
    pool += 26;
  }
  if (chars.some((char) => /\p{Nd}/u.test(char))) {
    pool += 10;
  }
  if (chars.some((char) => /[\p{P}\p{S}\p{Z}]/u.test(char))) {
    pool += 33;
  }
  if (chars.some((char) => /\p{L}/u.test(char) && !/\p{Ll}|\p{Lu}/u.test(char))) {
    pool += 100;
  }
  return Math.max(pool, 10);
}

function continues(previous: string, current: string): boolean {
  if (previous === current) {
    return true;
  }
  const step = (current.codePointAt(0) ?? 0) - (previous.codePointAt(0) ?? 0);
  if (Math.abs(step) === 1) {
    return true;
  }
  const pair = `${previous}${current}`.toLowerCase();
  const reversed = Array.from(pair).reverse().join("");
  return KEYBOARD_ROWS.some((row) => row.includes(pair) || row.includes(reversed));
}

function wordPositions(lowered: string, normalised: string): Map<number, number> {
  const found = new Map<number, number>();
  for (const text of [lowered, normalised]) {
    for (const word of COMMON_WORDS) {
      for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
        found.set(at, Math.max(found.get(at) ?? 0, word.length));
      }
    }
  }
  return found;
}

function isCommonPassword(normalised: string): boolean {
  const core = normalised.replace(/[^\p{L}]+$/u, "").replace(/^[^\p{L}]+/u, "");
  return core !== "" && COMMON_WORDS.some((word) => core === word);
}

/** A rough count of the bits of work a guesser needs for the password: its length and character mix, less what is predictable. */
function estimateBits(password: string): number {
  const chars = Array.from(password);
  if (chars.length === 0) {
    return 0;
  }
  const lowered = password.toLowerCase();
  const normalised = Array.from(lowered, (char) => LEET[char] ?? char).join("");
  if (isCommonPassword(normalised) || isCommonPassword(lowered)) {
    return Math.min(COMMON_PASSWORD_BITS, chars.length);
  }
  const words = wordPositions(lowered, normalised);
  const perChar = Math.log2(poolSize(chars));
  let bits = 0;
  for (let index = 0; index < chars.length; ) {
    const wordLength = words.get(index);
    if (wordLength !== undefined) {
      bits += WORD_BITS;
      index += wordLength;
      continue;
    }
    const previous = chars[index - 1];
    const current = chars[index] ?? "";
    bits += previous !== undefined && continues(previous, current) ? PREDICTABLE_BITS : perChar;
    index += 1;
  }
  return bits;
}

/**
 * The strength of a password as the meter shows it, from 0 to 4. It is a client-side estimate, in the spirit of
 * zxcvbn's score, and never leaves the browser; the server's policy alone decides whether a password is accepted.
 */
export function passwordScore(password: string): PasswordScore {
  const bits = estimateBits(password);
  const score: PasswordScore = bits < 24 ? 0 : bits < 40 ? 1 : bits < 64 ? 2 : bits < 90 ? 3 : 4;
  if (Array.from(password).length < MIN_LENGTH) {
    return score > 1 ? 1 : score;
  }
  return score;
}
