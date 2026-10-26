import { parseSlug } from "./slug.ts";

// The remembered go choices of a member in the workspace of the transaction (doc 02 section 6.4, doc 04 sections 6.1 and 10.3, doc 05 section 2.6, doc 10 T1 and T2): the
// list of them, in the order of their slugs, and forgetting one. A preference is its member's own, so no other member's is ever listed or forgotten. Only a choice whose
// bookmark is still a candidate of its slug for the member is listed, which is the one the resolution would follow, so a stale one (a bookmark with another slug, one that
// stopped forwarding, one the member cannot read, or a plan-archived one) is not offered; the resolution forgets the stale ones.

/** One remembered choice, as the store reads it with the bookmark it names. */
export interface GoPreferenceRecord {
  readonly slug: string;
  readonly bookmarkId: string;
  readonly title: string;
  /** The host of the destination. */
  readonly host: string;
  /** The bookmark's owner; null for a bookmark whose owner has left the workspace. */
  readonly ownerId: string | null;
  /** The owner's display name, as the member sees it as a co-member; null when the owner has left. */
  readonly ownerName: string | null;
}

export interface GoPreferenceStore {
  /** The member's remembered choices whose bookmark is still a candidate of the slug, in the order of the slugs, after `afterSlug` when given, at most `limit` of them. */
  listPreferences(request: { readonly accountId: string; readonly afterSlug: string | undefined; readonly limit: number }): Promise<readonly GoPreferenceRecord[]>;
  /** Deletes the member's choice for `slug` and answers whether there was one. */
  forgetPreference(request: { readonly slug: string; readonly accountId: string }): Promise<boolean>;
}

/** Signs and opens cursors; a cursor opens only for the `scope` it was sealed with. */
export interface GoPreferenceCursors {
  seal(afterSlug: string, scope: string): string;
  /** Undefined when the cursor was not sealed by this server for this scope. */
  open(cursor: string, scope: string): string | undefined;
}

/** A remembered choice as the caller sees it. */
export interface GoPreference {
  readonly slug: string;
  readonly bookmarkId: string;
  readonly title: string;
  readonly host: string;
  /** Who owns a bookmark that belongs to another member; null for the member's own and for one whose owner has left. */
  readonly owner: { readonly accountId: string; readonly displayName: string } | null;
}

export interface GoPreferenceListDependencies {
  readonly store: Pick<GoPreferenceStore, "listPreferences">;
  readonly cursors: GoPreferenceCursors;
}

export interface GoPreferenceListAsk {
  readonly workspaceId: string;
  /** The member whose choices are listed. */
  readonly accountId: string;
  /** 1 to 100. */
  readonly limit: number;
  readonly cursor: string | undefined;
}

export type GoPreferenceListOutcome =
  | { readonly kind: "listed"; readonly items: readonly GoPreference[]; readonly nextCursor: string | null }
  /** The cursor was not issued by this server for this account and workspace, or does not hold a slug; nothing was read. */
  | { readonly kind: "bad_cursor" };

function cursorScope(ask: GoPreferenceListAsk): string {
  return JSON.stringify([ask.workspaceId.toLowerCase(), ask.accountId.toLowerCase()]);
}

/** One page of `ask.accountId`'s remembered choices in the workspace of the transaction. */
export async function listGoPreferences({ store, cursors }: GoPreferenceListDependencies, ask: GoPreferenceListAsk): Promise<GoPreferenceListOutcome> {
  const accountId = ask.accountId.toLowerCase();
  const scope = cursorScope(ask);
  let afterSlug: string | undefined;
  if (ask.cursor !== undefined) {
    const opened = cursors.open(ask.cursor, scope);
    afterSlug = opened === undefined || parseSlug(opened) !== opened ? undefined : opened;
    if (afterSlug === undefined) {
      return { kind: "bad_cursor" };
    }
  }
  // One more than the page, to know whether another page follows.
  const fetched = await store.listPreferences({ accountId, afterSlug, limit: ask.limit + 1 });
  const page = fetched.slice(0, ask.limit);
  const last = page.at(-1);
  return {
    kind: "listed",
    items: page.map((record) => ({
      slug: record.slug,
      bookmarkId: record.bookmarkId,
      title: record.title,
      host: record.host,
      owner: record.ownerId !== null && record.ownerId !== accountId && record.ownerName !== null ? { accountId: record.ownerId, displayName: record.ownerName } : null,
    })),
    nextCursor: fetched.length > ask.limit && last !== undefined ? cursors.seal(last.slug, scope) : null,
  };
}

export interface GoPreferenceForgetDependencies {
  readonly store: Pick<GoPreferenceStore, "forgetPreference">;
}

export interface GoPreferenceForgetAsk {
  /** The member who forgets. */
  readonly accountId: string;
  /** The slug as the caller wrote it. */
  readonly slug: string;
}

/** Forgets the member's remembered choice for the slug; false when there is none, and for a slug outside the grammar, which has none. */
export async function forgetGoPreference({ store }: GoPreferenceForgetDependencies, ask: GoPreferenceForgetAsk): Promise<boolean> {
  const slug = parseSlug(ask.slug);
  if (slug === undefined) {
    return false;
  }
  return store.forgetPreference({ slug, accountId: ask.accountId.toLowerCase() });
}
