import { normalizeTagName, type TagNameRefusal, type TagRecord, type TagStore } from "./create.ts";

// Renaming a tag (doc 02 section 7.2, doc 04 section 10.7). Only the owner renames a tag: the store names the owner in the statement, so
// another member's tag and one of another workspace are a tag it does not find. A name the owner already uses on another tag is refused;
// merging the two is another operation.

export interface TagRenameRequest {
  readonly tagId: string;
  readonly ownerId: string;
  readonly name: string;
}

export type TagRenameResult =
  | { readonly kind: "renamed"; readonly tag: TagRecord }
  | { readonly kind: "unchanged"; readonly tag: TagRecord }
  | { readonly kind: "name_taken" }
  | { readonly kind: "not_found" };

export interface TagRenameDependencies {
  readonly store: Pick<TagStore, "rename">;
}

export interface TagRenameAsk {
  readonly tagId: string;
  /** The member who renames the tag. */
  readonly accountId: string;
  readonly name: string;
}

export type TagRenameOutcome = TagRenameResult | { readonly kind: "invalid_name"; readonly reason: TagNameRefusal };

export async function renameTag({ store }: TagRenameDependencies, ask: TagRenameAsk): Promise<TagRenameOutcome> {
  const normalized = normalizeTagName(ask.name);
  if ("refusal" in normalized) {
    return { kind: "invalid_name", reason: normalized.refusal };
  }
  return store.rename({ tagId: ask.tagId, ownerId: ask.accountId.toLowerCase(), name: normalized.name });
}
