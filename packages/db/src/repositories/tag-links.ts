import type { BookmarkTagName, BookmarkTagRef } from "@slugbase/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { bookmarkTags, tags } from "../schema/tags.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { distinctIdentifiers, requireIdentifiers, uuidArray } from "./folder-links.ts";
import { defineScopedRepository } from "./scoped.ts";

// The links between a member's bookmarks and the member's tags (doc 05 section 2.4, doc 02 sections 7.2 and 8.2, doc 10 T1 and T2), used by the
// bookmark repository. A link is the owner's alone: every statement names the workspace of the transaction and the owner of the tags, and the
// policies of `bookmark_tags` (src/sql/510-tags.sql, src/sql/550-bookmark-tagging.sql) refuse a link whose tag or bookmark is not the account's own in
// that workspace, so a statement that forgot a predicate still writes nothing of anyone else's.
//
// Lock order. What takes row locks on the bookmarks and the tags of a member below takes them in the one order the workspace row, then (for a tagging that
// creates a tag by name) the owner's membership row, then the bookmarks (in the order of their identifiers), then the tags (in the order of their identifiers):
//  - a creation locks the workspace row (`sys_bookmark_count_take`), inserts its bookmark (a row that is not committed is nobody else's to hold; the insert takes the
//    owner's membership row through its foreign key) and then locks its tags; a change that names a tag by name locks the workspace row and the owner's membership
//    row (`FOR KEY SHARE`, `lockTaggingOwner`) before its bookmark (`FOR UPDATE`), because the insert of the new tag takes both through its foreign keys, and then
//    locks its tags. A change that names tags by identifier only takes neither. Both lock every tag they name that exists, the ones named by identifier and the
//    existing ones named by name, in one statement (`lockTaggingTags`, `FOR KEY SHARE`), and insert the tags they create by name in the order of the lower-cased
//    names (`resolveTagNames`), so that two taggings which create the same names cannot wait for each other at the unique index of the owner's tag names;
//  - a merge of two tags locks the bookmarks of the source's links (`FOR KEY SHARE`) and then both tags (`FOR UPDATE`) (`lockTagsForMerge`);
//  - the departure of a member (the foreign keys of `bookmarks` and `tags` to `workspace_members`) locks the workspace row, deletes the membership row, clears the
//    owner of the member's bookmarks and then deletes the member's tags, and the deletion of an account locks the account's workspaces before anything else
//    (src/sql/290-account-deletion.sql);
//  - the deletion of a bookmark takes the bookmark and its links, and the deletion of a tag takes the tag and its links.
// So none of these waits for a bookmark while it holds a tag that the holder of that bookmark waits for, and a departure and a change queue on the workspace row or
// the membership row, which the one takes before it reaches the member's bookmarks and the other before it locks one. test/tag-merge-lock-order.integration.test.ts holds
// an interleaving of a merge with a change, with the deletion of a bookmark and with a tagging that commits, of a creation with the deletion of an account and with
// the removal of a member, and of a change with the removal of a member and with the deletion of an account, and each ends in its own answer; it also shows that
// a change which creates several names holds none of them while it waits for an earlier one (the insert order above). One case is outside that order. A tag a tagging names by name that the owner has none of is created, and a tag of such a name that another
// transaction creates after the tagging locked its tags is locked when the read that follows the insert finds it, after the tags that were locked in order.
// A tag named by identifier that is deleted or merged away before the tagging locks it is found gone and answered `tag_not_found` (a name it carried is created
// anew); one that the tagging has locked cannot be deleted under it. Tags named by name are the owner's tag of that name, whatever its case, or a new one,
// created in the transaction that links it. A tag that a name was resolved to, which another transaction created and committed, and that a different transaction deletes before the tagging has read it back
// (`resolveTagNames`), is answered `tag_not_found` as well, with the tags that call created undone. test/tag-lost-during-tagging.integration.test.ts holds these
// races with the deletion of a tag; none of its tests merges a tag away.

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

/** Whether every tag of `tagIds` is one `ownerId` owns in the workspace of the transaction, read without a lock: the check of a creation, which answers before it takes its place under the ceiling. */
export async function ownedTagsExist(tx: TenantTx, ownerId: string, tagIds: readonly string[]): Promise<boolean> {
  const workspaceId = requireWorkspace(tx, "tagging bookmarks");
  const wanted = distinctIdentifiers(tagIds);
  requireIdentifiers(wanted, "tagging bookmarks");
  if (wanted.length === 0) {
    return true;
  }
  const found = await tenantHandle(tx)
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.workspaceId, workspaceId), eq(tags.ownerId, ownerId), sql`${tags.id} = ANY (${uuidArray(wanted)}::uuid[])`));
  return found.length === wanted.length;
}

/**
 * Locks the workspace row and then the membership row of `ownerId` (`FOR KEY SHARE`), the two rows that the insert of a tag takes through its foreign keys, so that a
 * tagging which creates a tag by name takes them before its bookmark, the order every departure takes them in. Answers whether both exist: false when the workspace is
 * gone or the owner is no member of it any more, and the caller then answers as for a bookmark that is no longer the caller's, before it reads or writes the bookmark.
 */
export async function lockTaggingOwner(tx: TenantTx, ownerId: string): Promise<boolean> {
  const workspaceId = requireWorkspace(tx, "tagging bookmarks");
  requireIdentifiers([ownerId], "tagging bookmarks");
  const handle = tenantHandle(tx);
  const workspace = await handle.execute(sql`SELECT 1 FROM public.workspaces WHERE id = ${workspaceId}::uuid FOR KEY SHARE`);
  if (workspace.length === 0) {
    return false;
  }
  const member = await handle.execute(sql`
    SELECT 1 FROM public.workspace_members WHERE workspace_id = ${workspaceId}::uuid AND account_id = ${ownerId}::uuid FOR KEY SHARE`);
  return member.length === 1;
}

/**
 * Locks (`FOR KEY SHARE`) the tags `ownerId` owns in the workspace of the transaction that `tagging` names: the ones named by identifier and the
 * existing ones named by name (matched as the column is, without regard to case), all in one statement in the order of their identifiers. The
 * caller holds its bookmark already. Answers whether every tag named by identifier exists. A tag named by name that the owner has none of is not locked and not created here (`resolveTagNames`).
 */
export async function lockTaggingTags(tx: TenantTx, ownerId: string, tagging: { readonly ids: readonly string[]; readonly names: readonly BookmarkTagName[] }): Promise<boolean> {
  const workspaceId = requireWorkspace(tx, "tagging bookmarks");
  const wanted = distinctIdentifiers(tagging.ids);
  requireIdentifiers(wanted, "tagging bookmarks");
  if (wanted.length === 0 && tagging.names.length === 0) {
    return true;
  }
  const names = sql`ARRAY[${sql.join(
    tagging.names.map((tag) => sql`${tag.name}::citext`),
    sql`, `,
  )}]::citext[]`;
  const locked = await tenantHandle(tx).execute<{ id: string }>(sql`
    SELECT t.id FROM ${tags} AS t
    WHERE t.workspace_id = ${workspaceId}::uuid AND t.owner_id = ${ownerId}::uuid AND (t.id = ANY (${uuidArray(wanted)}::uuid[]) OR t.name = ANY (${names}))
    ORDER BY t.id
    FOR KEY SHARE OF t`);
  const found = new Set(locked.map((row) => row.id));
  return wanted.every((id) => found.has(id.toLowerCase()));
}

/** The numbers (positions in `names`) of the names that `ownerId` has a tag of, with the tag, locking the tags (`FOR KEY SHARE`; the ones `lockTaggingTags` locked are held already). The name is matched as the column is, without regard to case. */
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

function compareNames(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

const NAME_SAVEPOINT = sql.raw("tag_name_resolve");

/**
 * The identifiers of the tags `ownerId` owns that carry the names of `names` (matched without regard to case), creating a tag with `newId` for each
 * name the owner has none of, in the open transaction. The existing tags were locked by `lockTaggingTags` already; a tag it answers that is new is the
 * transaction's own, and a name a concurrent transaction creates at the same time is the tag that transaction made: the insert leaves it and the read that
 * follows finds and locks it. Answers `undefined` when a tag that the insert left is gone again by that read (another transaction deleted it after the
 * transaction that made it committed); the tags this call created are undone then (`ROLLBACK TO SAVEPOINT`), so that a caller which answers `tag_not_found` has written nothing for the names.
 */
export async function resolveTagNames(tx: TenantTx, ownerId: string, names: readonly BookmarkTagName[]): Promise<string[] | undefined> {
  const workspaceId = requireWorkspace(tx, "tagging bookmarks");
  if (names.length === 0) {
    return [];
  }
  let found = await tagsByName(tx, workspaceId, ownerId, names);
  // In the order of the lower-cased names, whatever order the request gave them in, so that two transactions which create the same names wait at the unique index in the same order.
  const missing = names.filter((_tag, index) => !found.has(index)).sort((a, b) => compareNames(a.name.toLowerCase(), b.name.toLowerCase()));
  if (missing.length > 0) {
    requireIdentifiers(missing.map((tag) => tag.newId), "creating tags");
    const handle = tenantHandle(tx);
    await handle.execute(sql`SAVEPOINT ${NAME_SAVEPOINT}`);
    // The statement names the columns the application role may insert; the query builder would name `created_at` too.
    await handle.execute(sql`
      INSERT INTO ${tags} (id, workspace_id, owner_id, name)
      VALUES ${sql.join(missing.map((tag) => sql`(${tag.newId}::uuid, ${workspaceId}::uuid, ${ownerId}::uuid, ${tag.name})`), sql`, `)}
      ON CONFLICT (workspace_id, owner_id, name) DO NOTHING`);
    found = await tagsByName(tx, workspaceId, ownerId, names);
    if (names.some((_tag, index) => !found.has(index))) {
      await handle.execute(sql`ROLLBACK TO SAVEPOINT ${NAME_SAVEPOINT}`);
      await handle.execute(sql`RELEASE SAVEPOINT ${NAME_SAVEPOINT}`);
      return undefined;
    }
    await handle.execute(sql`RELEASE SAVEPOINT ${NAME_SAVEPOINT}`);
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

/** Links every bookmark of `bookmarkIds` to every tag of `tagIds`, leaving the links that exist. The tags are locked and owned already, and so are the bookmarks. */
export async function insertTagLinksMany(tx: TenantTx, bookmarkIds: readonly string[], tagIds: readonly string[]): Promise<number> {
  const workspaceId = requireWorkspace(tx, "tagging bookmarks");
  const bookmarkList = distinctIdentifiers(bookmarkIds);
  const tagList = distinctIdentifiers(tagIds);
  requireIdentifiers(bookmarkList, "tagging bookmarks");
  requireIdentifiers(tagList, "tagging bookmarks");
  if (bookmarkList.length === 0 || tagList.length === 0) {
    return 0;
  }
  // The statement names the columns the application role may insert (a column grant).
  const inserted = await tenantHandle(tx).execute<{ tag_id: string }>(sql`
    INSERT INTO ${bookmarkTags} (workspace_id, bookmark_id, tag_id)
    SELECT ${workspaceId}::uuid, b.id, t.id FROM unnest(${uuidArray(bookmarkList)}::uuid[]) AS b(id) CROSS JOIN unnest(${uuidArray(tagList)}::uuid[]) AS t(id)
    ON CONFLICT (bookmark_id, tag_id) DO NOTHING
    RETURNING tag_id`);
  return inserted.length;
}

/** Removes the links of every bookmark of `bookmarkIds` to every tag of `tagIds` and answers how many there were. */
export async function deleteTagLinksMany(tx: TenantTx, bookmarkIds: readonly string[], tagIds: readonly string[]): Promise<number> {
  requireWorkspace(tx, "untagging bookmarks");
  const bookmarkList = distinctIdentifiers(bookmarkIds);
  const tagList = distinctIdentifiers(tagIds);
  requireIdentifiers(bookmarkList, "untagging bookmarks");
  requireIdentifiers(tagList, "untagging bookmarks");
  if (bookmarkList.length === 0 || tagList.length === 0) {
    return 0;
  }
  const deleted = await scoped
    .bind(tx)
    .delete(and(sql`${bookmarkTags.bookmarkId} = ANY (${uuidArray(bookmarkList)}::uuid[])`, sql`${bookmarkTags.tagId} = ANY (${uuidArray(tagList)}::uuid[])`));
  return deleted.length;
}

/** The tags of `tagIds` that `ownerId` owns in the workspace of the transaction, read without a lock; fewer than the distinct identifiers when one is not the owner's. */
export async function ownedTags(tx: TenantTx, ownerId: string, tagIds: readonly string[]): Promise<BookmarkTagRef[]> {
  const workspaceId = requireWorkspace(tx, "tagging bookmarks");
  const wanted = distinctIdentifiers(tagIds);
  requireIdentifiers(wanted, "tagging bookmarks");
  if (wanted.length === 0) {
    return [];
  }
  return tenantHandle(tx)
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(and(eq(tags.workspaceId, workspaceId), eq(tags.ownerId, ownerId), sql`${tags.id} = ANY (${uuidArray(wanted)}::uuid[])`))
    .orderBy(asc(tags.name), asc(tags.id));
}

const MERGE_LOCK_ROUNDS = 5;
const MERGE_LOCK_SAVEPOINT = sql.raw("tag_merge_locks");

/**
 * Locks what a merge of the tag `sourceId` into the tag `targetId` works on, in the order of this module: the bookmarks of the source's links (`FOR KEY SHARE`,
 * in the order of their identifiers), then both tags of `ownerId` (`FOR UPDATE`, in the order of their identifiers, in one statement). Answers whether both
 * tags exist and are the owner's. A bookmark that a concurrent transaction deletes is waited for and left out (its links went with it).
 *
 * A tagging adds a link to the source only while it holds the source `FOR KEY SHARE`, which the lock on the tags waits for, so the links of the source are final
 * once the tags are locked. But a tagging that committed after the bookmarks were read and before the tags were locked has added a link whose bookmark is not
 * locked. The links are read again under the tag locks: when one names a bookmark that is not locked, the round is undone (`ROLLBACK TO SAVEPOINT` releases its
 * bookmark and tag locks, so nothing waits on them) and the next round locks that bookmark with the others, before the tags. After `MERGE_LOCK_ROUNDS` rounds
 * that each found a new bookmark the call ends with an error, which rolls everything back.
 */
export async function lockTagsForMerge(tx: TenantTx, ownerId: string, sourceId: string, targetId: string): Promise<boolean> {
  const workspaceId = requireWorkspace(tx, "merging tags");
  requireIdentifiers([sourceId, targetId], "merging tags");
  const handle = tenantHandle(tx);
  const wanted = [...new Set([sourceId, targetId])].sort();
  const distinct = wanted.length === 2;
  for (let round = 0; round < MERGE_LOCK_ROUNDS; round += 1) {
    await handle.execute(sql`SAVEPOINT ${MERGE_LOCK_SAVEPOINT}`);
    const held = new Set<string>();
    if (distinct) {
      const locked = await handle.execute<{ id: string }>(sql`
        SELECT b.id FROM ${bookmarks} AS b
        WHERE b.workspace_id = ${workspaceId}::uuid
          AND b.id IN (SELECT l.bookmark_id FROM ${bookmarkTags} AS l WHERE l.workspace_id = ${workspaceId}::uuid AND l.tag_id = ${sourceId}::uuid)
        ORDER BY b.id
        FOR KEY SHARE OF b`);
      for (const row of locked) {
        held.add(row.id);
      }
    }
    const lockedTags = await handle.execute<{ id: string }>(sql`
      SELECT t.id FROM ${tags} AS t
      WHERE t.workspace_id = ${workspaceId}::uuid AND t.owner_id = ${ownerId}::uuid AND t.id = ANY (${uuidArray(wanted)}::uuid[])
      ORDER BY t.id
      FOR UPDATE OF t`);
    const complete =
      lockedTags.length === wanted.length &&
      (!distinct ||
        (
          await handle.execute<{ bookmark_id: string }>(sql`
            SELECT l.bookmark_id FROM ${bookmarkTags} AS l WHERE l.workspace_id = ${workspaceId}::uuid AND l.tag_id = ${sourceId}::uuid`)
        ).every((row) => held.has(row.bookmark_id)));
    if (lockedTags.length !== wanted.length || complete) {
      await handle.execute(sql`RELEASE SAVEPOINT ${MERGE_LOCK_SAVEPOINT}`);
      return complete;
    }
    await handle.execute(sql`ROLLBACK TO SAVEPOINT ${MERGE_LOCK_SAVEPOINT}`);
    await handle.execute(sql`RELEASE SAVEPOINT ${MERGE_LOCK_SAVEPOINT}`);
  }
  throw new Error("the links of a tag kept changing while it was locked for a merge");
}

/**
 * Links every bookmark that is linked to the tag `sourceId` to the tag `targetId` as well, leaving the links the target has, and answers how many were
 * new. The source stays, with its links: the caller deletes it. The caller holds the locks of `lockTagsForMerge`: both tags are the owner's, locked and
 * distinct, so every bookmark of the source's links is the owner's too (which the insert policy checks again), is locked, and gets no link to either tag
 * from any other transaction until the caller ends.
 */
export async function copyTagLinks(tx: TenantTx, sourceId: string, targetId: string): Promise<number> {
  const workspaceId = requireWorkspace(tx, "merging tags");
  requireIdentifiers([sourceId, targetId], "merging tags");
  // The statement names the columns the application role may insert (a column grant).
  const inserted = await tenantHandle(tx).execute<{ bookmark_id: string }>(sql`
    INSERT INTO ${bookmarkTags} (workspace_id, bookmark_id, tag_id)
    SELECT l.workspace_id, l.bookmark_id, ${targetId}::uuid FROM ${bookmarkTags} AS l
    WHERE l.workspace_id = ${workspaceId}::uuid AND l.tag_id = ${sourceId}::uuid
    ON CONFLICT (bookmark_id, tag_id) DO NOTHING
    RETURNING bookmark_id`);
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
