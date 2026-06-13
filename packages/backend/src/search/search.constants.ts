/** Default per-type cap for GET /search (command palette preview). */
export const DEFAULT_SEARCH_LIMIT_PER_TYPE = 10;

/** Hard ceiling for per-type limit query params on GET /search. */
export const MAX_SEARCH_LIMIT_PER_TYPE = 50;

/** List endpoints the web client uses when server results are truncated. */
export const GLOBAL_SEARCH_FALLBACK = {
  bookmarks: { path: "/bookmarks", queryParam: "q" as const },
  folders: { path: "/folders", queryParam: "q" as const },
  tags: { path: "/tags", queryParam: "q" as const },
} as const;
