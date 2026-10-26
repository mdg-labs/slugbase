import type { BookmarkStore } from "../bookmarks/create.ts";
import { parseSlug } from "./slug.ts";

// Whether a slug is free for the caller (doc 04 section 10.6, doc 02 section 6.1, doc 10 T2). A slug is unique per owner within a workspace, so
// it is taken when another bookmark of the caller's has it; other members' bookmarks never make it unavailable, and are only counted, for the
// collision hint, without saying whose they are. The bookmark the caller is editing is left out of the comparison, so its own slug is available.

/** What the store counts for a slug in the workspace of the transaction. */
export interface SlugUse {
  /** True when a bookmark of `ownerId` other than `exceptBookmarkId` has the slug, a plan-archived one included (the key of the table counts it). */
  readonly takenByOwner: boolean;
  /** How many bookmarks that `ownerId` does not own, ownerless ones included, have the slug and are not plan-archived. */
  readonly othersUseCount: number;
}

export interface SlugAvailabilityStore {
  /** The use of `slug` (normalised) in the workspace of the transaction, as the account of the transaction sees it. */
  slugUse(request: { readonly slug: string; readonly ownerId: string; readonly exceptBookmarkId: string | undefined }): Promise<SlugUse>;
  /** The bookmark of the workspace of the transaction with that identifier, whoever owns it; undefined when there is none. */
  find: BookmarkStore["find"];
}

export interface SlugAvailabilityDependencies {
  readonly store: SlugAvailabilityStore;
}

export interface SlugAvailabilityAsk {
  /** The member who asks. */
  readonly accountId: string;
  /** The slug as the caller wrote it. */
  readonly slug: string;
  /** The caller's bookmark the slug is being set on; none for a new bookmark. */
  readonly bookmarkId: string | undefined;
}

export type SlugAvailabilityOutcome =
  | { readonly kind: "checked"; readonly status: "available" | "taken_by_me" | "invalid"; readonly othersUseCount: number }
  /** `bookmarkId` names no bookmark the account owns: another member's, another workspace's, plan-archived or unknown, which a caller must not tell apart. */
  | { readonly kind: "bookmark_not_found" };

/** Answers whether `ask.slug` is free for the account in the workspace of the transaction. */
export async function slugAvailability({ store }: SlugAvailabilityDependencies, ask: SlugAvailabilityAsk): Promise<SlugAvailabilityOutcome> {
  const accountId = ask.accountId.toLowerCase();
  let bookmarkId: string | undefined;
  if (ask.bookmarkId !== undefined) {
    const bookmark = await store.find(ask.bookmarkId);
    if (bookmark === undefined || bookmark.ownerId !== accountId) {
      return { kind: "bookmark_not_found" };
    }
    bookmarkId = bookmark.id;
  }
  const slug = parseSlug(ask.slug);
  if (slug === undefined) {
    return { kind: "checked", status: "invalid", othersUseCount: 0 };
  }
  const use = await store.slugUse({ slug, ownerId: accountId, exceptBookmarkId: bookmarkId });
  return { kind: "checked", status: use.takenByOwner ? "taken_by_me" : "available", othersUseCount: use.othersUseCount };
}
