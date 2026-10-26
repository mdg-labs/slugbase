import { BOOKMARK_SLUG_PATTERN } from "@slugbase/contracts";

// The slug rules of doc 02 section 6.1. A slug is trimmed and lower-cased wherever it enters, and only then held to the grammar: nothing else is
// rewritten, so a slug outside the grammar is refused and never repaired. A slug is stored and compared lower-case, so two spellings that differ
// only in case are one slug. There are no reserved words: every slug lives under `/go/`.

/** The slug as it is judged, written and looked up: the whitespace around it removed and its letters lower-cased. */
export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

/** Whether `slug`, already normalised, is in the grammar: 1 to 64 lower-case letters, digits and hyphens, not starting with a hyphen. */
export function isValidSlug(slug: string): boolean {
  return BOOKMARK_SLUG_PATTERN.test(slug);
}

/** The slug of `input` when its normal form is in the grammar; undefined otherwise. */
export function parseSlug(input: string): string | undefined {
  const slug = normalizeSlug(input);
  return isValidSlug(slug) ? slug : undefined;
}
