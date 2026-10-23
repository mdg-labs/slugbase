import type { BookmarkStore } from "./create.ts";
import { readBookmark } from "./read.ts";
import { normalizeBookmarkUrl } from "./url.ts";

// Opening a bookmark (doc 02 section 5.5, doc 04 section 10.6, doc 10 T1, T2 and T12). An open answers the destination to go to and
// counts the use. Whether the account may open the bookmark is the rule of reading it, so another member's bookmark, one of another
// workspace and one that does not exist are the same `not_found`, and nothing is counted for them. The stored URL is checked again
// to be an `http` or `https` URL before it is handed back, as the table's check and the creation already ensure, so the destination
// a client navigates to is never a script. Only then is the open counted, in the usage buffer, which never blocks the answer.

/** Where an open is counted; the buffer of the server process, which writes the counts to the database on a timer. */
export interface BookmarkUsage {
  /** Counts one open of the bookmark now. Synchronous and memory-only, so it cannot fail and cannot delay the answer. */
  record(bookmarkId: string): void;
}

export interface BookmarkOpenDependencies {
  readonly store: Pick<BookmarkStore, "find">;
  readonly usage: BookmarkUsage;
}

export interface BookmarkOpenAsk {
  readonly bookmarkId: string;
  /** The member who opens the bookmark. */
  readonly accountId: string;
}

export type BookmarkOpenOutcome =
  /** The destination, and the open is counted. */
  | { readonly kind: "opened"; readonly url: string }
  /** The account can read no such bookmark; which of the reasons it is stays unsaid. Nothing is counted. */
  | { readonly kind: "not_found" }
  /** The stored URL is not an `http` or `https` URL. Nothing is counted. */
  | { readonly kind: "url_refused" };

export async function openBookmark({ store, usage }: BookmarkOpenDependencies, ask: BookmarkOpenAsk): Promise<BookmarkOpenOutcome> {
  const bookmark = await readBookmark({ store }, ask);
  if (bookmark === undefined) {
    return { kind: "not_found" };
  }
  const destination = normalizeBookmarkUrl(bookmark.url);
  if (!destination.ok) {
    return { kind: "url_refused" };
  }
  usage.record(bookmark.id);
  return { kind: "opened", url: destination.value.url };
}
