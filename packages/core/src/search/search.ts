// The search of a member's readable bookmarks, own folders and own tags (doc 02 section 9.1, doc 04 section 10.8, Q49, doc 10 T1 and T2). The query is text a person typed: it is
// never SQL, `tsquery` or `LIKE` syntax, and this module only cleans it up (control characters, runs of white space and a length cap) and decides which groups to ask for and how many
// results each may hold. Matching and ranking are the store's: bookmarks rank an exact slug, a slug prefix, full text over the `simple` vector and then trigram similarity on
// title and host; folders and tags match by name. The store answers for the account of the transaction only, so another member's bookmark, folder or tag and anything of another
// workspace is never in an answer.

export const SEARCH_TYPES = ["bookmark", "folder", "tag"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** The most characters of a query that are searched for; the rest is ignored. */
export const SEARCH_QUERY_MAX_LENGTH = 100;

/** How many results of each type a search returns when `limit` is left out. */
export const SEARCH_DEFAULT_LIMITS: Readonly<Record<SearchType, number>> = { bookmark: 8, folder: 4, tag: 4 };

/** The most results of one type a search returns, whatever `limit` asks for. */
export const SEARCH_MAX_LIMIT = 20;

export interface BookmarkHit {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly host: string;
  readonly slug: string | null;
  readonly forwarding: boolean;
  readonly pinned: boolean;
}

export interface FolderHit {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly color: number;
}

export interface TagHit {
  readonly id: string;
  readonly name: string;
}

export interface SearchStore {
  /** The bookmarks the account of the transaction can read in its workspace that match `text`, best first, at most `limit`; plan-archived bookmarks never match. */
  bookmarks(request: { readonly text: string; readonly limit: number }): Promise<readonly BookmarkHit[]>;
  /** The account's own folders whose name matches `text`, exact name first, then a prefix, then the rest, at most `limit`. */
  folders(request: { readonly accountId: string; readonly text: string; readonly limit: number }): Promise<readonly FolderHit[]>;
  /** The account's own tags whose name matches `text`, in the order of the folders. */
  tags(request: { readonly accountId: string; readonly text: string; readonly limit: number }): Promise<readonly TagHit[]>;
}

export interface SearchDependencies {
  readonly store: SearchStore;
}

export interface SearchAsk {
  readonly accountId: string;
  readonly query: string;
  /** The groups to search; all three when left out. */
  readonly types?: readonly SearchType[];
  /** The most results of each type, 1 to 20; 8 bookmarks, 4 folders and 4 tags when left out. */
  readonly limit?: number;
}

export interface SearchResult {
  readonly bookmarks: readonly BookmarkHit[];
  readonly folders: readonly FolderHit[];
  readonly tags: readonly TagHit[];
}

/**
 * The text of a query as it is searched for: Unicode-normalised (NFKC), control and format characters (the NUL among them, which the database refuses) taken out as white space,
 * runs of white space made one space, the whitespace around it removed and the first `SEARCH_QUERY_MAX_LENGTH` characters kept. Empty when nothing searchable is left.
 */
export function normalizeSearchQuery(query: string): string {
  const cleaned = query
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(cleaned).slice(0, SEARCH_QUERY_MAX_LENGTH).join("").trim();
}

function limitOf(type: SearchType, ask: SearchAsk): number {
  const asked = ask.limit === undefined ? SEARCH_DEFAULT_LIMITS[type] : Math.trunc(ask.limit);
  return Math.min(Math.max(asked, 1), SEARCH_MAX_LIMIT);
}

/** The matches of the query in the groups asked for; a group that was not asked for, and every group of a query with nothing to search for, is empty. */
export async function search({ store }: SearchDependencies, ask: SearchAsk): Promise<SearchResult> {
  const text = normalizeSearchQuery(ask.query);
  const types = new Set(ask.types ?? SEARCH_TYPES);
  if (text === "") {
    return { bookmarks: [], folders: [], tags: [] };
  }
  const accountId = ask.accountId.toLowerCase();
  // One after the other: the three reads share the one connection of the transaction.
  const bookmarks = types.has("bookmark") ? await store.bookmarks({ text, limit: limitOf("bookmark", ask) }) : [];
  const folders = types.has("folder") ? await store.folders({ accountId, text, limit: limitOf("folder", ask) }) : [];
  const tags = types.has("tag") ? await store.tags({ accountId, text, limit: limitOf("tag", ask) }) : [];
  return { bookmarks, folders, tags };
}
