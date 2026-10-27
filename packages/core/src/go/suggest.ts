import { GO_SUGGEST_MAX } from "@slugbase/contracts";
import type { GoAccess } from "./resolve.ts";
import { normalizeSlug } from "./slug.ts";

// The slugs a member can complete a prefix to in the workspace of the transaction (doc 02 section 9.2, doc 04 section 10.8, doc 05 section 4, doc 10 T1, T2 and T12): the palette's
// `go` mode lists them as the member types. They are the bookmarks the resolution of a slug could name (the store applies the same candidate rule and the same access rule as
// `GoStore.candidates`), so a bookmark that `POST /go/resolve` would not name for the member, because it is another member's, another workspace's, does not forward or is
// plan-archived, is never suggested, and a suggestion names no address. The prefix is plain text: it is trimmed and lower-cased and never SQL or `LIKE` syntax, which the store sees to.

/** The longest prefix that can match a slug (the grammar's 64 characters). */
export const GO_SUGGEST_PREFIX_MAX_LENGTH = 64;

/** A bookmark whose slug starts with the prefix, as the store finds it. */
export interface GoSuggestionRecord {
  readonly bookmarkId: string;
  readonly slug: string;
  readonly title: string;
  /** The host of the destination. */
  readonly host: string;
  /** The bookmark's owner; null for a bookmark whose owner has left the workspace. */
  readonly ownerId: string | null;
  /** The owner's display name, as the member sees it as a co-member; null when the owner has left. */
  readonly ownerName: string | null;
  /** How the member can read the bookmark. */
  readonly access: GoAccess;
}

export interface GoSuggestStore {
  /**
   * The bookmarks of the workspace of the transaction whose slug starts with `prefix` (trimmed and lower-cased, never empty) that forward, are not plan-archived and that
   * `accountId` can read, the member's own first and then by slug, at most `limit` of them.
   */
  suggest(request: { readonly prefix: string; readonly accountId: string; readonly limit: number }): Promise<readonly GoSuggestionRecord[]>;
}

/** One suggestion as the caller sees it. */
export interface GoSuggestion {
  readonly slug: string;
  readonly bookmarkId: string;
  readonly title: string;
  readonly host: string;
  /** Who owns a bookmark shared with the member; null for the member's own and for one whose owner has left. */
  readonly owner: { readonly accountId: string; readonly displayName: string } | null;
  /** How a bookmark is shared with the member; null for the member's own. */
  readonly sharedVia: "direct" | "team" | "folder" | null;
}

export interface GoSuggestDependencies {
  readonly store: GoSuggestStore;
}

export interface GoSuggestAsk {
  /** The member who types. */
  readonly accountId: string;
  /** The prefix as the caller wrote it. */
  readonly prefix: string;
}

/** The prefix as it is looked up, or undefined when nothing can match: it is empty, longer than a slug, or holds a control character, which the database refuses. */
function lookupPrefix(input: string): string | undefined {
  const prefix = normalizeSlug(input);
  return prefix === "" || prefix.length > GO_SUGGEST_PREFIX_MAX_LENGTH || /\p{Cc}/u.test(prefix) ? undefined : prefix;
}

/** The slugs that start with the prefix, among the bookmarks the member can read; empty for an empty prefix. */
export async function suggestSlugs({ store }: GoSuggestDependencies, ask: GoSuggestAsk): Promise<readonly GoSuggestion[]> {
  const prefix = lookupPrefix(ask.prefix);
  if (prefix === undefined) {
    return [];
  }
  const records = await store.suggest({ prefix, accountId: ask.accountId.toLowerCase(), limit: GO_SUGGEST_MAX });
  return records.slice(0, GO_SUGGEST_MAX).map((record) => ({
    slug: record.slug,
    bookmarkId: record.bookmarkId,
    title: record.title,
    host: record.host,
    owner: record.access !== "owner" && record.ownerId !== null && record.ownerName !== null ? { accountId: record.ownerId, displayName: record.ownerName } : null,
    sharedVia: record.access === "owner" ? null : record.access,
  }));
}
