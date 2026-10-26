import type { TagRecord, TagStore } from "./create.ts";

// Merging a tag into another (doc 02 section 7.2, doc 04 section 10.7, doc 05 section 2.4, doc 10 T2). Only the owner merges tags, and only
// their own: the store names the owner in every statement, so a tag of another member, of another workspace and one that does not exist are
// the same `not_found`, as the source and as the target. A merge is one unit: the links of the source go to the target, a bookmark that has both
// keeps one link, and the source is deleted, or nothing is written. A tag cannot be merged into itself; that is judged after the tags are
// found, so naming a tag that is not the owner's twice is `not_found` like naming it once.

export interface TagMergeRequest {
  /** The tag that is merged and deleted. */
  readonly sourceId: string;
  /** The tag that receives its links. */
  readonly targetId: string;
  readonly ownerId: string;
}

export type TagMergeResult =
  /** The target as it now is, with the number of bookmarks it carries. */
  | { readonly kind: "merged"; readonly tag: TagRecord }
  | { readonly kind: "not_found" }
  /** The source and the target are one tag of the owner. */
  | { readonly kind: "same_tag" };

export interface TagMergeDependencies {
  readonly store: Pick<TagStore, "merge">;
}

export interface TagMergeAsk {
  readonly tagId: string;
  readonly intoTagId: string;
  /** The member who merges the tags. */
  readonly accountId: string;
}

export function mergeTag({ store }: TagMergeDependencies, ask: TagMergeAsk): Promise<TagMergeResult> {
  return store.merge({ sourceId: ask.tagId.toLowerCase(), targetId: ask.intoTagId.toLowerCase(), ownerId: ask.accountId.toLowerCase() });
}
