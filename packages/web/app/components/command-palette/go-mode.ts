import type { SearchBookmarkHit } from "../../lib/search.types.js";

/** Max slug matches shown in palette go mode (proto PaletteApp.jsx). */
export const GO_SLUG_MATCH_LIMIT = 6;

const GO_MODE_PREFIX = /^go\s/i;
const PASTED_GO_PATH = /^\/?go\/([a-z0-9][a-z0-9-]{0,63})\/?$/i;
const PASTED_GO_HOST =
  /(?:^|\s)(?:[a-z0-9.-]*\.)?go\.[a-z0-9.-]+\/([a-z0-9][a-z0-9-]{0,63})\/?$/i;

export type PaletteQueryMode = "default" | "search" | "go";

export interface ParsedPaletteQuery {
  mode: PaletteQueryMode;
  /** Lowercase slug prefix after `go ` or from a pasted redirect path. */
  slugPrefix: string;
}

export function parsePaletteQuery(raw: string): ParsedPaletteQuery {
  const trimmed = raw.trim();

  const pastedPath = trimmed.match(PASTED_GO_PATH);
  if (pastedPath?.[1]) {
    return {
      mode: "go",
      slugPrefix: pastedPath[1].toLowerCase(),
    };
  }

  const pastedHost = trimmed.match(PASTED_GO_HOST);
  if (pastedHost?.[1]) {
    return {
      mode: "go",
      slugPrefix: pastedHost[1].toLowerCase(),
    };
  }

  if (GO_MODE_PREFIX.test(trimmed)) {
    return {
      mode: "go",
      slugPrefix: trimmed.replace(/^go\s+/i, "").trim().toLowerCase(),
    };
  }

  if (trimmed.length > 0) {
    return { mode: "search", slugPrefix: "" };
  }

  return { mode: "default", slugPrefix: "" };
}

export function filterGoSlugMatches(
  bookmarks: SearchBookmarkHit[],
  slugPrefix: string,
  limit = GO_SLUG_MATCH_LIMIT,
): SearchBookmarkHit[] {
  return bookmarks
    .filter(
      (bookmark) =>
        bookmark.forwardingEnabled &&
        bookmark.slug != null &&
        bookmark.slug.length > 0,
    )
    .filter((bookmark) => {
      const slug = bookmark.slug;
      if (!slug) return false;
      return slugPrefix.length === 0 || slug.toLowerCase().startsWith(slugPrefix);
    })
    .slice(0, limit);
}

export function goRouteForSlug(slug: string): string {
  return `/go/${slug}`;
}

export function openGoTarget(path: string, newTab: boolean): void {
  if (newTab) {
    window.open(path, "_blank", "noopener,noreferrer");
  } else {
    window.location.assign(path);
  }
}
