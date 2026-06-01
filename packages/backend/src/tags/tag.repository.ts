import { coerceCount } from "../db/coerce-count.js";
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, ilike, sql, type SQL } from "drizzle-orm";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import {
  bookmarkTags,
  tags,
} from "../db/schema/index.js";
import {
  WorkspaceScopedRepository,
  type WorkspaceOwned,
} from "../db/workspace-scoped.repository.js";
import type {
  CreateTagData,
  PaginatedTags,
  ParsedListTagsQuery,
  TagRecord,
  UpdateTagData,
} from "./tag.types.js";
import {
  DEFAULT_TAG_PAGE_SIZE,
  type TagSort,
  parsePage,
  parsePageSize,
} from "./tag.validation.js";

type TagRow = WorkspaceOwned & {
  id: string;
  userId: string;
  name: string;
  color: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
};

function toDate(value: Date | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function escapeLikePattern(q: string): string {
  return q.replace(/[%_\\]/g, "\\$&");
}

function orderByForSort(
  sort: TagSort,
  tagsTable: typeof tags,
  bookmarkTagsTable: typeof bookmarkTags,
) {
  switch (sort) {
    case "name-asc":
      return asc(tagsTable.name);
    case "name-desc":
      return desc(tagsTable.name);
    case "created-asc":
      return asc(tagsTable.createdAt);
    case "usage-desc":
      return desc(
        sql`(SELECT count(*) FROM ${bookmarkTagsTable} bt WHERE bt.tag_id = ${tagsTable.id} AND bt.workspace_id = ${tagsTable.workspaceId})`,
      );
    case "usage-asc":
      return asc(
        sql`(SELECT count(*) FROM ${bookmarkTagsTable} bt WHERE bt.tag_id = ${tagsTable.id} AND bt.workspace_id = ${tagsTable.workspaceId})`,
      );
    case "created-desc":
    default:
      return desc(tagsTable.createdAt);
  }
}

export class TagRepository extends WorkspaceScopedRepository<TagRecord> {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- forwards db to WorkspaceScopedRepository
  constructor(db: DrizzleClient) {
    super(db);
  }

  async create(
    workspaceId: string,
    userId: string,
    data: CreateTagData,
  ): Promise<TagRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

        const rows = await this.db
      .insert(tags)
      .values({
        id,
        workspaceId,
        userId,
        name: data.name,
        color: data.color ?? null,
        createdAt: nowMs,
        updatedAt: nowMs,
      })
      .returning();
    const row = rows[0];
    const tag = this.assertOwnership(
      workspaceId,
      row ? await this.toTagRecord(row) : null,
    );
    if (data.bookmarkIds?.length) {
      await this.replaceTagBookmarks(workspaceId, userId, id, data.bookmarkIds);
      const withLinks = await this.findById(workspaceId, id);
      if (!withLinks) throw new Error("Failed to load tag after bookmark links");
      return withLinks;
    }
    return tag;
  }

  async findById(workspaceId: string, tagId: string): Promise<TagRecord | null> {

    const rows = await this.db
      .select()
      .from(tags)
      .where(and(eq(tags.id, tagId), eq(tags.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ? await this.toTagRecord(rows[0]) : null;
  }

  async list(
    workspaceId: string,
    userId: string,
    query: ParsedListTagsQuery,
  ): Promise<PaginatedTags> {
    const sort = query.sort;
    const page = parsePage(query.page);
    const pageSize = parsePageSize(query.pageSize ?? DEFAULT_TAG_PAGE_SIZE);
    const offset = (page - 1) * pageSize;
    const searchPattern =
      query.q && query.q.trim().length > 0
        ? `%${escapeLikePattern(query.q.trim())}%`
        : null;

        const conditions: SQL[] = [
      eq(tags.workspaceId, workspaceId),
      eq(tags.userId, userId),
    ];
    if (searchPattern) {
      conditions.push(ilike(tags.name, searchPattern));
    }
    const whereClause = and(...conditions);

    const countRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(tags)
      .where(whereClause);
    const total = coerceCount(countRows[0]?.count);

    const rows = await this.db
      .select()
      .from(tags)
      .where(whereClause)
      .orderBy(orderByForSort(sort, tags, bookmarkTags))
      .limit(pageSize)
      .offset(offset);

    const items = await Promise.all(rows.map((row) => this.toTagRecord(row)));
    return { items, total, page, pageSize };
  }

  async update(
    workspaceId: string,
    tagId: string,
    patch: UpdateTagData,
  ): Promise<TagRecord | null> {
    const nowMs = Date.now();
    const updates: Record<string, unknown> = { updatedAt: nowMs };

    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.color !== undefined) updates.color = patch.color;

    await this.db
      .update(tags)
      .set(updates)
      .where(and(eq(tags.id, tagId), eq(tags.workspaceId, workspaceId)));

    return this.findById(workspaceId, tagId);
  }

  async delete(workspaceId: string, tagId: string): Promise<void> {
    await this.deleteBookmarkTagLinksForTag(workspaceId, tagId);

    await this.db
      .delete(tags)
      .where(and(eq(tags.id, tagId), eq(tags.workspaceId, workspaceId)));
  }

  async replaceTagBookmarks(
    workspaceId: string,
    _userId: string,
    tagId: string,
    bookmarkIds: string[],
  ): Promise<void> {
    await this.deleteBookmarkTagLinksForTag(workspaceId, tagId);

    const uniqueIds = [...new Set(bookmarkIds)];
    for (const bookmarkId of uniqueIds) {
      await this.insertBookmarkTagLink(workspaceId, tagId, bookmarkId);
    }
  }

  async addBookmarkToTag(
    workspaceId: string,
    _userId: string,
    tagId: string,
    bookmarkId: string,
  ): Promise<void> {
    const exists = await this.hasBookmarkTagLink(
      workspaceId,
      tagId,
      bookmarkId,
    );
    if (exists) return;
    await this.insertBookmarkTagLink(workspaceId, tagId, bookmarkId);
  }

  async removeBookmarkFromTag(
    workspaceId: string,
    tagId: string,
    bookmarkId: string,
  ): Promise<void> {

    await this.db
      .delete(bookmarkTags)
      .where(
        and(
          eq(bookmarkTags.workspaceId, workspaceId),
          eq(bookmarkTags.tagId, tagId),
          eq(bookmarkTags.bookmarkId, bookmarkId),
        ),
      );
  }

  async countTagsForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<number> {

    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(bookmarkTags)
      .where(
        and(
          eq(bookmarkTags.workspaceId, workspaceId),
          eq(bookmarkTags.bookmarkId, bookmarkId),
        ),
      );
    return coerceCount(rows[0]?.count);
  }

  async listTagIdsForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<string[]> {

    const rows = await this.db
      .select({ tagId: bookmarkTags.tagId })
      .from(bookmarkTags)
      .where(
        and(
          eq(bookmarkTags.workspaceId, workspaceId),
          eq(bookmarkTags.bookmarkId, bookmarkId),
        ),
      );
    return rows.map((r) => r.tagId);
  }

  async deleteBookmarkTagLinksForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<void> {

    await this.db
      .delete(bookmarkTags)
      .where(
        and(
          eq(bookmarkTags.workspaceId, workspaceId),
          eq(bookmarkTags.bookmarkId, bookmarkId),
        ),
      );
  }

  private async deleteBookmarkTagLinksForTag(
    workspaceId: string,
    tagId: string,
  ): Promise<void> {

    await this.db
      .delete(bookmarkTags)
      .where(
        and(
          eq(bookmarkTags.workspaceId, workspaceId),
          eq(bookmarkTags.tagId, tagId),
        ),
      );
  }

  private async hasBookmarkTagLink(
    workspaceId: string,
    tagId: string,
    bookmarkId: string,
  ): Promise<boolean> {

    const rows = await this.db
      .select({ id: bookmarkTags.id })
      .from(bookmarkTags)
      .where(
        and(
          eq(bookmarkTags.workspaceId, workspaceId),
          eq(bookmarkTags.tagId, tagId),
          eq(bookmarkTags.bookmarkId, bookmarkId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  private async insertBookmarkTagLink(
    workspaceId: string,
    tagId: string,
    bookmarkId: string,
  ): Promise<void> {
    const id = randomUUID();
    const nowMs = Date.now();

    await this.db.insert(bookmarkTags).values({
      id,
      workspaceId,
      tagId,
      bookmarkId,
      createdAt: nowMs,
    });
  }

  private async countBookmarksOnTag(
    workspaceId: string,
    tagId: string,
  ): Promise<number> {

    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(bookmarkTags)
      .where(
        and(
          eq(bookmarkTags.workspaceId, workspaceId),
          eq(bookmarkTags.tagId, tagId),
        ),
      );
    return coerceCount(rows[0]?.count);
  }

  private async toTagRecord(row: TagRow): Promise<TagRecord> {
    const bookmarkCount = await this.countBookmarksOnTag(row.workspaceId, row.id);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      name: row.name,
      color: row.color,
      bookmarkCount,
      createdAt: toDate(row.createdAt),
      updatedAt: toDate(row.updatedAt),
    };
  }
}
