import type { NewTag, TagPosition, TagRecord, TagRenameRequest, TagRenameResult, TagSort, TagStore, TagStoreCreationResult } from "@slugbase/core";
import { and, asc, desc, eq, isNull, not, sql, type SQL } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { bookmarkTags, tags } from "../schema/tags.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { defineScopedRepository } from "./scoped.ts";

// The tags of the active workspace (doc 05 section 2.4, doc 02 section 7.2, doc 10 T2). A tag is its owner's alone: the policies of
// `tags` name the owner as well as the workspace (src/sql/510-tags.sql), and every statement below names both too, so the application
// and the database each keep another member's tags out of an answer. The owner of a statement is always the account of the transaction;
// a request that names another account is a programming error and throws. `slugbase_app` may insert the columns of a creation, rename
// (update the name) and delete; deleting a tag deletes its links by foreign key.
//
// The unique key `(workspace_id, owner_id, name)` is the judge of a name that is taken. A creation inserts with `ON CONFLICT DO NOTHING`
// and a rename updates only where no other tag of the owner has the name, so a name that is taken is an answer and not an error, and
// two creations of one name at the same time make one tag. Two renames to one name that overlap can still both pass their check and meet
// at the key; the loser's statement fails, which ends the transaction it ran in with nothing written, and `isTagNameTaken` tells that
// failure from any other so the caller answers it as a name that is taken.
// A page is at most `limit` tags after the place the previous page ended at; `count` is the capped total of the owner's tags.
// The count of a tag is the number of bookmarks it is linked to that are not plan-archived, which is what a list of bookmarks shows.

const scoped = defineScopedRepository("tags", tags, {
  insertColumns: ["id", "ownerId", "name"],
  updateColumns: ["name"],
});

const UNIQUE_VIOLATION = "23505";
const NAME_CONSTRAINT = "tags_owner_name_key";
const MAX_CAUSE_DEPTH = 4;

/** Whether the error is the database refusing a statement because the owner has a tag of that name already, on the error itself or on one of its causes. */
export function isTagNameTaken(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    const { code, constraint_name: constraint, cause } = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (code === UNIQUE_VIOLATION && constraint === NAME_CONSTRAINT) {
      return true;
    }
    current = cause;
  }
  return false;
}

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "the tags of a workspace need a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

function requireOwner(tx: TenantTx, ownerId: string): string {
  if (ownerId.toLowerCase() !== tx.accountId) {
    throw new Error("a tag is read and written for the account of the transaction only");
  }
  return tx.accountId;
}

interface TagRow {
  readonly id: string;
  readonly name: string;
  readonly bookmarkCount: number;
  readonly createdAt: Date;
}

function recordOf(row: TagRow): TagRecord {
  return { id: row.id, name: row.name, bookmarkCount: row.bookmarkCount, createdAt: row.createdAt };
}

const ORDERS: Readonly<Record<TagSort, readonly SQL[]>> = {
  name: [asc(tags.name), asc(tags.id)],
  count: [desc(sql`count(${bookmarks.id})`), asc(tags.name), asc(tags.id)],
};

/**
 * The statement of `TagRepository.list`: the tags of `ownerId` in the workspace of the transaction, or the one tag `tagId`, with their counts,
 * in the order of `sort` and after `after`, at most `limit`. The keyset of the sort by name is (name, id) and is a condition on rows; the
 * keyset of the sort by count is (count descending, name, id) and is a condition on the groups, since the count is an aggregate.
 */
function tagsOf(tx: TenantTx, request: { readonly ownerId: string; readonly sort: TagSort; readonly after: TagPosition | undefined; readonly limit: number | undefined; readonly tagId: string | undefined }): Promise<TagRow[]> {
  const workspaceId = requireWorkspace(tx);
  const { ownerId, sort, after, limit, tagId } = request;
  const bookmarkCount = sql<number>`count(${bookmarks.id})::int`;
  const afterName = after === undefined ? undefined : sql`(${tags.name}, ${tags.id}) > (${after.name}::citext, ${after.id}::uuid)`;
  const rowsAfter = sort === "name" ? afterName : undefined;
  const groupsAfter =
    sort === "count" && after !== undefined && after.count !== undefined
      ? sql`(count(${bookmarks.id}) < ${after.count}::bigint OR (count(${bookmarks.id}) = ${after.count}::bigint AND ${afterName}))`
      : undefined;
  const query = tenantHandle(tx)
    .select({ id: tags.id, name: tags.name, createdAt: tags.createdAt, bookmarkCount })
    .from(tags)
    .leftJoin(bookmarkTags, and(eq(bookmarkTags.workspaceId, tags.workspaceId), eq(bookmarkTags.tagId, tags.id)))
    .leftJoin(bookmarks, and(eq(bookmarks.workspaceId, bookmarkTags.workspaceId), eq(bookmarks.id, bookmarkTags.bookmarkId), isNull(bookmarks.planArchivedAt)))
    .where(and(eq(tags.workspaceId, workspaceId), eq(tags.ownerId, ownerId), tagId === undefined ? undefined : eq(tags.id, tagId), rowsAfter))
    .groupBy(tags.id)
    .having(groupsAfter)
    .orderBy(...ORDERS[sort]);
  return limit === undefined ? query : query.limit(limit);
}

export type TagRepository = TagStore;

export function tagRepository(tx: TenantTx): TagRepository {
  const rows = scoped.bind(tx);
  return {
    async create(tag: NewTag): Promise<TagStoreCreationResult> {
      const ownerId = requireOwner(tx, tag.ownerId);
      const workspaceId = requireWorkspace(tx);
      // The statement names the columns the application role may insert; the query builder would name `created_at` too.
      const inserted = await tenantHandle(tx).execute<{ id: string }>(sql`
        INSERT INTO ${tags} (id, workspace_id, owner_id, name) VALUES (${tag.id}, ${workspaceId}, ${ownerId}, ${tag.name})
        ON CONFLICT (workspace_id, owner_id, name) DO NOTHING
        RETURNING id`);
      if (inserted.length === 0) {
        return { kind: "name_taken" };
      }
      const [stored] = await rows.select(and(eq(tags.id, tag.id), eq(tags.ownerId, ownerId)));
      if (stored === undefined) {
        throw new Error("an inserted tag cannot be read back");
      }
      return { kind: "created", tag: { id: stored.id, name: stored.name, bookmarkCount: 0, createdAt: stored.createdAt } };
    },

    async list({ ownerId, sort, after, limit }) {
      return (await tagsOf(tx, { ownerId: requireOwner(tx, ownerId), sort, after, limit, tagId: undefined })).map(recordOf);
    },

    async count(ownerId, limit) {
      const owner = requireOwner(tx, ownerId);
      const workspaceId = requireWorkspace(tx);
      const handle = tenantHandle(tx);
      const capped = handle.select({ one: sql<number>`1`.as("one") }).from(tags).where(and(eq(tags.workspaceId, workspaceId), eq(tags.ownerId, owner))).limit(limit).as("capped");
      const [row] = await handle.select({ total: sql<number>`count(*)::int` }).from(capped);
      if (row === undefined) {
        throw new Error("counting tags returned no row");
      }
      return row.total;
    },

    async rename({ tagId, ownerId, name }: TagRenameRequest): Promise<TagRenameResult> {
      const owner = requireOwner(tx, ownerId);
      const [current] = await rows.select(and(eq(tags.id, tagId), eq(tags.ownerId, owner)));
      if (current === undefined) {
        return { kind: "not_found" };
      }
      if (current.name !== name) {
        const taken = sql`EXISTS (SELECT 1 FROM ${tags} AS other WHERE other.workspace_id = ${tags.workspaceId} AND other.owner_id = ${tags.ownerId} AND other.name = ${name} AND other.id <> ${tags.id})`;
        const renamed = await rows.update({ name }, and(eq(tags.id, tagId), eq(tags.ownerId, owner), not(taken)));
        if (renamed.length === 0) {
          // The tag exists and is the owner's, so either another tag of the owner has the name or this one was deleted since it was read.
          const [still] = await rows.select(and(eq(tags.id, tagId), eq(tags.ownerId, owner)));
          return still === undefined ? { kind: "not_found" } : { kind: "name_taken" };
        }
      }
      const [read] = await tagsOf(tx, { ownerId: owner, sort: "name", after: undefined, limit: undefined, tagId });
      if (read === undefined) {
        return { kind: "not_found" };
      }
      return current.name === name ? { kind: "unchanged", tag: recordOf(read) } : { kind: "renamed", tag: recordOf(read) };
    },

    async remove({ tagId, ownerId }) {
      const owner = requireOwner(tx, ownerId);
      const deleted = await rows.delete(and(eq(tags.id, tagId), eq(tags.ownerId, owner)));
      return deleted.length > 0;
    },
  };
}
