/** Prototype hostname-hashed accent palette (`data.js` fav colors). */
export const BOOKMARK_GLYPH_COLORS = [
  "#7782f7",
  "#45c98a",
  "#e6b24e",
  "#f0686b",
  "#56b6e6",
  "#b178f7",
  "#f78fb0",
  "#5fd6a0",
] as const;

export function getBookmarkHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Deterministic accent from bookmark URL hostname (prototype `fav(host)`). */
export function getBookmarkGlyphColor(url: string): string {
  const host = getBookmarkHostname(url);
  const index = host.length > 0 ? host.charCodeAt(0) % BOOKMARK_GLYPH_COLORS.length : 0;
  return BOOKMARK_GLYPH_COLORS[index] ?? BOOKMARK_GLYPH_COLORS[0];
}

/**
 * Derives 1–2 uppercase alphanumeric initials from a bookmark title.
 * Uses the first alphanumeric of up to two words; for a single word, may add a second letter.
 */
export function getBookmarkMonogramInitials(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    return "?";
  }

  const words = trimmed.split(/\s+/);
  const initials: string[] = [];

  for (const word of words) {
    for (const char of word) {
      if (/[a-zA-Z0-9]/.test(char)) {
        initials.push(char.toUpperCase());
        break;
      }
    }
    if (initials.length >= 2) {
      break;
    }
  }

  const singleWord = words[0];
  if (initials.length === 1 && singleWord) {
    let foundFirst = false;
    for (const char of singleWord) {
      if (/[a-zA-Z0-9]/.test(char)) {
        if (foundFirst) {
          initials.push(char.toUpperCase());
          break;
        }
        foundFirst = true;
      }
    }
  }

  return initials.join("") || "?";
}

export function bookmarkGlyphBorderRadius(size: number): number {
  return size > 24 ? 6 : 4;
}

export function bookmarkGlyphFontSize(size: number, initials: string): number {
  const scale = initials.length > 1 ? 0.36 : 0.42;
  return Math.max(9, Math.round(size * scale));
}
