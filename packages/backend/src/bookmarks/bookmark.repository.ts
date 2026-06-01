import { coerceCount } from "../db/coerce-count.js";
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, ilike, or, sql, type SQL } from "drizzle-orm";

import { bookmarkScopeCondition } from "../common/authz/authz-sql.js";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import {
  bookmarkFolders,
  bookmarkTags,
  bookmarks,
  slugPreferences,
} from "../db/schema/index.js";
import type {
  BookmarkIdsResult,
  BookmarkRecord,
  CreateBookmarkData,
  CreateSlugPreferenceData,
  PaginatedBookmarks,
  ParsedListBookmarksQuery,
  SlugPreferenceRecord,
  UpdateBookmarkData,
} from "./bookmark.types.js";
import {
  DEFAULT_BOOKMARK_PAGE_SIZE,
  type BookmarkScope,
  type BookmarkSort,
  parsePage,
  parsePageSize,
} from "./bookmark.validation.js";
import {
  WorkspaceScopedRepository,
  type WorkspaceOwned,
} from "../db/workspace-scoped.repository.js";
import { SharingRepository } from "../sharing/sharing.repository.js";

type BookmarkRow = WorkspaceOwned & {
  id: string;
  userId: string;
  title: string;
  url: string;
  slug: string | null;
  forwardingEnabled: boolean;
  pinned: boolean;
  planArchived: boolean;
  accessCount: number;
  lastAccessedAt: Date | number | null;
  createdAt: Date | number;
  updatedAt: Date | number;
};

function toBookmarkRecord(row: BookmarkRow): BookmarkRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    title: row.title,
    url: row.url,
    slug: row.slug,
    forwardingEnabled: row.forwardingEnabled,
    pinned: row.pinned,
    planArchived: row.planArchived,
    accessCount: row.accessCount,
    lastAccessedAt:
      row.lastAccessedAt == null
        ? null
        : row.lastAccessedAt instanceof Date
          ? row.lastAccessedAt
          : new Date(row.lastAccessedAt),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt),
  };
}

function escapeLikePattern(q: string): string {
  return q.replace(/[%_\\]/g, "\\$&");
}

function scopeCondition(
  scope: BookmarkScope,
  userId: string,
  workspaceId: string,
  bookmarksTable: typeof bookmarks,
): SQL {
  return bookmarkScopeCondition(scope, workspaceId, userId, bookmarksTable);
}

function archivePriorityOrder(
  bookmarksTable: typeof bookmarks,
) {
  return [
    asc(sql`${bookmarksTable.lastAccessedAt} IS NULL`),
    desc(bookmarksTable.lastAccessedAt),
    desc(bookmarksTable.createdAt),
  ];
}

function orderByForSort(
  sort: BookmarkSort,
  bookmarksTable: typeof bookmarks,
) {
  switch (sort) {
    case "title-asc":
      return asc(bookmarksTable.title);
    case "access-count-desc":
      return desc(bookmarksTable.accessCount);
    case "last-accessed-desc":
      return [
        asc(sql`${bookmarksTable.lastAccessedAt} IS NULL`),
        desc(bookmarksTable.lastAccessedAt),
      ];
    case "created-desc":
    default:
      return desc(bookmarksTable.createdAt);
  }
}

function buildListConditions(
  workspaceId: string,
  userId: string,
  query: ParsedListBookmarksQuery,
  bookmarksTable: typeof bookmarks,
  bookmarkFoldersTable: typeof bookmarkFolders,
  bookmarkTagsTable: typeof bookmarkTags,
): SQL[] {
  const conditions: SQL[] = [
    eq(bookmarksTable.workspaceId, workspaceId),
    eq(bookmarksTable.planArchived, false),
    scopeCondition(query.scope, userId, workspaceId, bookmarksTable),
  ];

  if (query.pinned !== undefined) {
    conditions.push(eq(bookmarksTable.pinned, query.pinned));
  }

  if (query.folderId) {
    conditions.push(
      sql`exists (
        select 1 from ${bookmarkFoldersTable}
        where ${bookmarkFoldersTable.bookmarkId} = ${bookmarksTable.id}
          and ${bookmarkFoldersTable.folderId} = ${query.folderId}
          and ${bookmarkFoldersTable.workspaceId} = ${workspaceId}
      )`,
    );
  }

  if (query.tagIds && query.tagIds.length > 0) {
    const tagCount = query.tagIds.length;
    conditions.push(
      sql`${bookmarksTable.id} in (
        select ${bookmarkTagsTable.bookmarkId}
        from ${bookmarkTagsTable}
        where ${bookmarkTagsTable.workspaceId} = ${workspaceId}
          and ${bookmarkTagsTable.tagId} in (${sql.join(
            query.tagIds.map((id) => sql`${id}`),
            sql`, `,
          )})
        group by ${bookmarkTagsTable.bookmarkId}
        having count(distinct ${bookmarkTagsTable.tagId}) = ${tagCount}
      )`,
    );
  }

  const searchPattern =
    query.q && query.q.trim().length > 0
      ? `%${escapeLikePattern(query.q.trim())}%`
      : null;
  if (searchPattern) {
    const searchClause = or(
      ilike(bookmarksTable.title, searchPattern),
      ilike(bookmarksTable.url, searchPattern),
      ilike(bookmarksTable.slug, searchPattern),
    );
    if (searchClause) conditions.push(searchClause);
  }

  return conditions;
}

function toSlugPreferenceRecord(row: {
  id: string;
  workspaceId: string;
  userId: string;
  slug: string;
  bookmarkId: string;
  createdAt: Date | number;
}): SlugPreferenceRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    slug: row.slug,
    bookmarkId: row.bookmarkId,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}

export class BookmarkRepository extends WorkspaceScopedRepository<BookmarkRecord> {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- forwards db to WorkspaceScopedRepository
  constructor(db: DrizzleClient) {
    super(db);
  }

  async create(
    workspaceId: string,
    userId: string,
    data: CreateBookmarkData,
  ): Promise<BookmarkRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

        const rows = await this.db
      .insert(bookmarks)
      .values({
        id,
        workspaceId,
        userId,
        title: data.title,
        url: data.url,
        slug: data.slug ?? null,
        forwardingEnabled: data.forwardingEnabled ?? false,
        pinned: data.pinned ?? false,
        planArchived: false,
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: nowMs,
        updatedAt: nowMs,
      })
      .returning();
    const row = rows[0];
    return this.assertOwnership(workspaceId, row ? toBookmarkRecord(row) : null);
  }

  /** Active bookmarks ordered for downgrade archive/restore selection (def §5). */
  async listActiveInWorkspaceOrdered(workspaceId: string): Promise<BookmarkRecord[]> {
    const orderBy = archivePriorityOrder(
      bookmarks,
    );

    const rows = await this.db
      .select()
      .from(bookmarks)
      .where(
        and(
          eq(bookmarks.workspaceId, workspaceId),
          eq(bookmarks.planArchived, false),
        ),
      )
      .orderBy(...orderBy);
    return rows.map(toBookmarkRecord);
  }

  /** Plan-archived bookmarks ordered for restore selection (def §5). */
  async listPlanArchivedInWorkspaceOrdered(workspaceId: string): Promise<BookmarkRecord[]> {
    const orderBy = archivePriorityOrder(
      bookmarks,
    );

    const rows = await this.db
      .select()
      .from(bookmarks)
      .where(
        and(
          eq(bookmarks.workspaceId, workspaceId),
          eq(bookmarks.planArchived, true),
        ),
      )
      .orderBy(...orderBy);
    return rows.map(toBookmarkRecord);
  }

  async bulkSetPlanArchived(
    workspaceId: string,
    bookmarkIds: string[],
    planArchived: boolean,
  ): Promise<void> {
    if (bookmarkIds.length === 0) {
      return;
    }

    const nowMs = Date.now();

    await this.db
      .update(bookmarks)
      .set({
        planArchived,
        updatedAt: nowMs,
      })
      .where(
        and(
          eq(bookmarks.workspaceId, workspaceId),
          inArray(bookmarks.id, bookmarkIds),
        ),
      );
  }

  /** Counts non-archived bookmarks in the workspace (spec §12.5 — cap applies to active bookmarks). */
  async countActiveInWorkspace(workspaceId: string): Promise<number> {

    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(bookmarks)
      .where(
        and(
          eq(bookmarks.workspaceId, workspaceId),
          eq(bookmarks.planArchived, false),
        ),
      );
    return coerceCount(rows[0]?.count);
  }

  async findById(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<BookmarkRecord | null> {

    const rows = await this.db
      .select()
      .from(bookmarks)
      .where(
        and(
          eq(bookmarks.id, bookmarkId),
          eq(bookmarks.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return rows[0] ? toBookmarkRecord(rows[0]) : null;
  }

  async list(
    workspaceId: string,
    userId: string,
    query: ParsedListBookmarksQuery,
  ): Promise<PaginatedBookmarks> {
    const page = parsePage(query.page);
    const pageSize = parsePageSize(query.pageSize ?? DEFAULT_BOOKMARK_PAGE_SIZE);
    const offset = (page - 1) * pageSize;
    const orderBy = orderByForSort(
      query.sort,
      bookmarks,
    );
    const orderByClause = Array.isArray(orderBy) ? orderBy : [orderBy];

        const conditions = buildListConditions(
      workspaceId,
      userId,
      query,
      bookmarks,
      bookmarkFolders,
      bookmarkTags,
    );
    const whereClause = and(...conditions);

    const countRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(bookmarks)
      .where(whereClause);
    const total = coerceCount(countRows[0]?.count);

    const rows = await this.db
      .select()
      .from(bookmarks)
      .where(whereClause)
      .orderBy(...orderByClause)
      .limit(pageSize)
      .offset(offset);

    return {
      items: rows.map(toBookmarkRecord),
      total,
      page,
      pageSize,
    };
  }

  async listIds(
    workspaceId: string,
    userId: string,
    query: ParsedListBookmarksQuery,
  ): Promise<BookmarkIdsResult> {
    const orderBy = orderByForSort(
      query.sort,
      bookmarks,
    );
    const orderByClause = Array.isArray(orderBy) ? orderBy : [orderBy];

        const conditions = buildListConditions(
      workspaceId,
      userId,
      query,
      bookmarks,
      bookmarkFolders,
      bookmarkTags,
    );
    const whereClause = and(...conditions);

    const countRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(bookmarks)
      .where(whereClause);
    const total = coerceCount(countRows[0]?.count);

    const rows = await this.db
      .select({ id: bookmarks.id })
      .from(bookmarks)
      .where(whereClause)
      .orderBy(...orderByClause);

    return { ids: rows.map((r) => r.id), total };
  }

  async findBySlug(
    workspaceId: string,
    slug: string,
  ): Promise<BookmarkRecord | null> {

    const rows = await this.db
      .select()
      .from(bookmarks)
      .where(
        and(eq(bookmarks.workspaceId, workspaceId), eq(bookmarks.slug, slug)),
      )
      .limit(1);
    return rows[0] ? toBookmarkRecord(rows[0]) : null;
  }

  async update(
    workspaceId: string,
    bookmarkId: string,
    patch: UpdateBookmarkData,
  ): Promise<BookmarkRecord | null> {
    const nowMs = Date.now();
    const updates: Record<string, unknown> = { updatedAt: nowMs };

    if (patch.title !== undefined) updates.title = patch.title;
    if (patch.url !== undefined) updates.url = patch.url;
    if (patch.slug !== undefined) updates.slug = patch.slug;
    if (patch.forwardingEnabled !== undefined) {
      updates.forwardingEnabled = patch.forwardingEnabled;
    }
    if (patch.pinned !== undefined) updates.pinned = patch.pinned;
    if (patch.planArchived !== undefined) updates.planArchived = patch.planArchived;

    await this.db
      .update(bookmarks)
      .set(updates)
      .where(
        and(
          eq(bookmarks.id, bookmarkId),
          eq(bookmarks.workspaceId, workspaceId),
        ),
      );

    return this.findById(workspaceId, bookmarkId);
  }

  async delete(workspaceId: string, bookmarkId: string): Promise<void> {
    const sharingRepo = new SharingRepository(this.db);
    await sharingRepo.deleteSharesForBookmark(workspaceId, bookmarkId);
    await this.deleteSlugPreferencesForBookmark(workspaceId, bookmarkId);
    await this.deleteBookmarkFolderLinksForBookmark(workspaceId, bookmarkId);
    await this.deleteBookmarkTagLinksForBookmark(workspaceId, bookmarkId);

    await this.db
      .delete(bookmarks)
      .where(
        and(
          eq(bookmarks.id, bookmarkId),
          eq(bookmarks.workspaceId, workspaceId),
        ),
      );
  }

  async incrementAccessCount(
    workspaceId: string,
    bookmarkId: string,
    accessedAtMs: number,
  ): Promise<void> {

    await this.db
      .update(bookmarks)
      .set({
        accessCount: sql`${bookmarks.accessCount} + 1`,
        lastAccessedAt: accessedAtMs,
        updatedAt: accessedAtMs,
      })
      .where(
        and(
          eq(bookmarks.id, bookmarkId),
          eq(bookmarks.workspaceId, workspaceId),
        ),
      );
  }

  async createSlugPreference(
    data: CreateSlugPreferenceData,
  ): Promise<SlugPreferenceRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

        const rows = await this.db
      .insert(slugPreferences)
      .values({
        id,
        workspaceId: data.workspaceId,
        userId: data.userId,
        slug: data.slug,
        bookmarkId: data.bookmarkId,
        createdAt: nowMs,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create slug preference");
    return toSlugPreferenceRecord(row);
  }

  async countSlugPreferencesForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<number> {

    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(slugPreferences)
      .where(
        and(
          eq(slugPreferences.workspaceId, workspaceId),
          eq(slugPreferences.bookmarkId, bookmarkId),
        ),
      );
    return coerceCount(rows[0]?.count);
  }

  private async deleteBookmarkFolderLinksForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<void> {

    await this.db
      .delete(bookmarkFolders)
      .where(
        and(
          eq(bookmarkFolders.workspaceId, workspaceId),
          eq(bookmarkFolders.bookmarkId, bookmarkId),
        ),
      );
  }

  private async deleteBookmarkTagLinksForBookmark(
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

  private async deleteSlugPreferencesForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<void> {

    await this.db
      .delete(slugPreferences)
      .where(
        and(
          eq(slugPreferences.workspaceId, workspaceId),
          eq(slugPreferences.bookmarkId, bookmarkId),
        ),
      );
  }
}
