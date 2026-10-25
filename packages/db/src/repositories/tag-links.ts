import type { BookmarkTagName, BookmarkTagRef } from "@slugbase/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { bookmarkTags, tags } from "../schema/tags.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { distinctIdentifiers, requireIdentifiers, uuidArray } from "./folder-links.ts";
import { defineScopedRepository } from "./scoped.ts";

// The links between a member's bookmarks and the member's tags (doc 05 section 2.4, doc 02 sections 7.2 and 8.2, doc 10 T1 and T2), used by the
// bookmark repository. A link is the owner's alone: every statement names the workspace of the transaction and the owner of the tags, and the
// policies of `bookmark_tags` (src/sql/510-tags.sql, src/sql/550-bookmark-tagging.sql) refuse a link whose tag or bookmark is not the account's own in
// that workspace, so a statement that forgot a predicate still writes nothing of anyone else's. Tags named by identifier are checked before the first
// write (`lockOwnedTags` without the lock). The tags named by name are resolved next (`resolveTagNames`: the owner's existing tags of those names are
// locked with `FOR KEY SHARE`, the missing ones created), and the tags named by identifier are locked with `FOR KEY SHARE` last, in the order of their
// identifiers: a tag that a concurrent transaction deletes is then either found gone or waited for, and never met half-way by the foreign key of the
// link. Tags named by name are the owner's tag of that name, whatever its case, or a new one, created in the transaction that links it.

// The registry entry of `bookmark_tags` for the cross-tenant matrix (doc 08 section 3.3): the application role may read, insert (the columns of a link
// but `workspace_id`, which the helper stamps) and delete links, and the policies keep each to the account's own tag and bookmark. Links are written in
// sets by `insertTagLinks`, whose statement is the one the entry's insert is judged by, and removed through the entry's delete.
const scoped = defineScopedRepository("bookmark_tags", bookmarkTags, {
  methods: ["select", "insert", "delete"],
  insertColumns: ["bookmarkId", "tagId"],
});

function requireWorkspace(tx: TenantTx, action: string): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", `${action} needs a tenant transaction opened with a workspace`);
  }
  return tx.workspaceId;
}

/**
 * Checks that every tag of `tagIds` is one `ownerId` owns in the workspace of the transaction, and locks them (`FOR KEY SHARE`, unless `lock` is false,
 * which only reads them). Answers whether every one of them exists.
 */
export async function lockOwnedTags(tx: TenantTx, ownerId: string, tagIds: readonly string[], lock = true): Promise<boolean> {
  const workspaceId = requireWorkspace(tx, "tagging bookmarks");
  const wanted = distinctIdentifiers(tagIds);
  requireIdentifiers(wanted, "tagging bookmarks");
  if (wanted.length === 0) {
    return true;
  }
  const query = tenantHandle(tx)
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.workspaceId, workspaceId), eq(tags.ownerId, ownerId), sql`${tags.id} = ANY (${uuidArray(wanted)}::uuid[])`))
    .orderBy(tags.id);
  return (lock ? await query.for("key share") : await query).length === wanted.length;
}

/** The numbers (positions in `names`) of the names that `ownerId` has a tag of, with the tag, locking the tags (`FOR KEY SHARE`). The name is matched as the column is, without regard to case. */
async function tagsByName(tx: TenantTx, workspaceId: string, ownerId: string, names: readonly BookmarkTagName[]): Promise<Map<number, string>> {
  const wanted = sql.join(
    names.map((tag, index) => sql`(${index}::int, ${tag.name}::citext)`),
    sql`, `,
  );
  const found = await tenantHandle(tx).execute<{ position: number; id: string }>(sql`
    SELECT v.position, t.id
    FROM (VALUES ${wanted}) AS v(position, name)
    INNER JOIN ${tags} AS t ON t.workspace_id = ${workspaceId}::uuid AND t.owner_id = ${ownerId}::uuid AND t.name = v.name
    ORDER BY t.id
    FOR KEY SHARE OF t`);
  return new Map(found.map((row) => [row.position, row.id]));
}

/**
 * The identifiers of the tags `ownerId` owns that carry the names of `names` (matched without regard to case), creating a tag with `newId` for each
 * name the owner has none of, in the open transaction. Every tag it answers is locked (`FOR KEY SHARE`). A name a concurrent transaction creates at the
 * same time is the tag that transaction made: the insert leaves it and the read that follows finds it.
 */
export async function resolveTagNames(tx: TenantTx, ownerId: string, names: readonly BookmarkTagName[]): Promise<string[]> {
  const workspaceId = requireWorkspace(tx, "tagging bookmarks");
  if (names.length === 0) {
    return [];
  }
  let found = await tagsByName(tx, workspaceId, ownerId, names);
  const missing = names.filter((_tag, index) => !found.has(index));
  if (missing.length > 0) {
    requireIdentifiers(missing.map((tag) => tag.newId), "creating tags");
    // The statement names the columns the application role may insert; the query builder would name `created_at` too.
    await tenantHandle(tx).execute(sql`
      INSERT INTO ${tags} (id, workspace_id, owner_id, name)
      VALUES ${sql.join(missing.map((tag) => sql`(${tag.newId}::uuid, ${workspaceId}::uuid, ${ownerId}::uuid, ${tag.name})`), sql`, `)}
      ON CONFLICT (workspace_id, owner_id, name) DO NOTHING`);
    found = await tagsByName(tx, workspaceId, ownerId, names);
    if (names.some((_tag, index) => !found.has(index))) {
      // A tag that was there a moment ago is gone again: the call ends with an error, which rolls everything it wrote back.
      throw new Error("a tag named for a bookmark was deleted while the bookmark was tagged");
    }
  }
  return distinctIdentifiers([...found.values()]);
}

/** Links the bookmark `bookmarkId` to every tag of `tagIds`, leaving the links that exist, and answers how many were new. The tags are locked and owned already, and so is the bookmark. */
export async function insertTagLinks(tx: TenantTx, bookmarkId: string, tagIds: readonly string[]): Promise<number> {
  const workspaceId = requireWorkspace(tx, "tagging bookmarks");
  const tagList = distinctIdentifiers(tagIds);
  requireIdentifiers(tagList, "tagging bookmarks");
  requireIdentifiers([bookmarkId], "tagging bookmarks");
  if (tagList.length === 0) {
    return 0;
  }
  // The statement names the columns the application role may insert (a column grant).
  const inserted = await tenantHandle(tx).execute<{ tag_id: string }>(sql`
    INSERT INTO ${bookmarkTags} (workspace_id, bookmark_id, tag_id)
    SELECT ${workspaceId}::uuid, ${bookmarkId}::uuid, t.id FROM unnest(${uuidArray(tagList)}::uuid[]) AS t(id)
    ON CONFLICT (bookmark_id, tag_id) DO NOTHING
    RETURNING tag_id`);
  return inserted.length;
}

/** Removes the links of the bookmark `bookmarkId` to the tags of `tagIds` and answers how many there were. */
export async function deleteTagLinks(tx: TenantTx, bookmarkId: string, tagIds: readonly string[]): Promise<number> {
  requireWorkspace(tx, "untagging bookmarks");
  const tagList = distinctIdentifiers(tagIds);
  requireIdentifiers(tagList, "untagging bookmarks");
  requireIdentifiers([bookmarkId], "untagging bookmarks");
  if (tagList.length === 0) {
    return 0;
  }
  const deleted = await scoped.bind(tx).delete(and(eq(bookmarkTags.bookmarkId, bookmarkId), sql`${bookmarkTags.tagId} = ANY (${uuidArray(tagList)}::uuid[])`));
  return deleted.length;
}

/** The statement of `tagsOfBookmarks`, exported for the test that plans it. The identifiers are UUIDs, distinct. */
export function tagsOfBookmarksQuery(tx: TenantTx, ownerId: string, bookmarkIds: readonly string[]) {
  const workspaceId = requireWorkspace(tx, "reading the tags of bookmarks");
  return tenantHandle(tx)
    .select({ bookmarkId: bookmarkTags.bookmarkId, id: tags.id, name: tags.name })
    .from(bookmarkTags)
    .innerJoin(tags, and(eq(tags.workspaceId, bookmarkTags.workspaceId), eq(tags.id, bookmarkTags.tagId)))
    .where(and(eq(bookmarkTags.workspaceId, workspaceId), eq(tags.ownerId, ownerId), sql`${bookmarkTags.bookmarkId} = ANY (${uuidArray(bookmarkIds)}::uuid[])`))
    .orderBy(asc(tags.name), asc(tags.id));
}

/** The tags `ownerId` has put on each of `bookmarkIds`, by bookmark, in the order of the tags' names (the identifier breaks a tie). Another member's tags are never in it. */
export async function tagsOfBookmarks(tx: TenantTx, ownerId: string, bookmarkIds: readonly string[]): Promise<Map<string, BookmarkTagRef[]>> {
  const found = new Map<string, BookmarkTagRef[]>();
  const wanted = distinctIdentifiers(bookmarkIds);
  requireIdentifiers(wanted, "reading the tags of bookmarks");
  if (wanted.length === 0) {
    return found;
  }
  for (const { bookmarkId, ...tag } of await tagsOfBookmarksQuery(tx, ownerId, wanted)) {
    const list = found.get(bookmarkId);
    if (list === undefined) {
      found.set(bookmarkId, [tag]);
    } else {
      list.push(tag);
    }
  }
  return found;
}
