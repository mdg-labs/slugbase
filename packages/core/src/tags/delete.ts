import type { TagStore } from "./create.ts";

// Deleting a tag (doc 02 section 7.2, doc 04 section 2.4 and 10.7). A delete is hard: the tag goes with its links to bookmarks, which
// stay. Only the owner deletes a tag, and the store keeps no tombstone, so a delete of a tag that is gone, that another member owns or
// that belongs to another workspace is the same `false`.

export interface TagDeletionDependencies {
  readonly store: Pick<TagStore, "remove">;
}

export interface TagDeletionAsk {
  readonly tagId: string;
  /** The member who deletes the tag. */
  readonly accountId: string;
}

/** True when the tag was deleted; false when the account owns no such tag, which a caller must not tell apart from any other case. */
export function deleteTag({ store }: TagDeletionDependencies, ask: TagDeletionAsk): Promise<boolean> {
  return store.remove({ tagId: ask.tagId, ownerId: ask.accountId.toLowerCase() });
}
