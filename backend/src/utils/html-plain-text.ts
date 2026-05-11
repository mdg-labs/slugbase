/**
 * Linear-time HTML-ish to plain text for email alternates and similar.
 * Avoids regexp patterns that-backtrack catastrophically on many "<" chars (ReDoS).
 */

const MAX_HTML_STRIP_INPUT = 100_000;

/**
 * Removes HTML tags without using regexp on unbounded ">…<" spans.
 */
export function stripHtmlTagsLinear(html: string): string {
  if (html.length > MAX_HTML_STRIP_INPUT) {
    html = html.slice(0, MAX_HTML_STRIP_INPUT);
  }
  let out = '';
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const c = html.charCodeAt(i);
    const ch = String.fromCodePoint(c);
    if (inTag) {
      if (ch === '>') inTag = false;
    } else if (ch === '<') {
      inTag = true;
    } else {
      out += ch;
    }
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Decode a small set of HTML entities in one pass (no chained &amp;→& rules).
 */
export function decodeBasicHtmlEntitiesOnce(raw: string): string {
  return raw.replace(/&(#[0-9]{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z\d]*);/gi, (full, ent: string) => {
    if (ent[0] !== '#') {
      const named = NAMED_ENTITIES[ent.toLowerCase()];
      return named !== undefined ? named : full;
    }
    const num =
      ent[1]?.toLowerCase() === 'x' ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
    if (!Number.isFinite(num) || num < 0 || num > 0x10ffff) return full;
    try {
      return String.fromCodePoint(num);
    } catch {
      return full;
    }
  });
}

/**
 * Produce a bounded plain-text snippet from HTML (email text bodies, tooling).
 */
export function htmlToPlainTextSnippet(html: string, maxLen: number): string {
  let s = stripHtmlTagsLinear(html);
  s = decodeBasicHtmlEntitiesOnce(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, maxLen);
}
