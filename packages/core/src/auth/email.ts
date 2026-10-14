/**
 * The form an email address is stored and looked up in (doc 02 section 2.1):
 * Unicode NFKC-normalised and trimmed, with its case kept. Accounts are
 * compared case-insensitively on top of this (the column is `citext`), so two
 * spellings that differ only in case, in width or in compatibility characters
 * name one account.
 */
export function normalizeEmail(raw: string): string {
  return raw.normalize("NFKC").trim();
}
