import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";

import { bookmarkScopeCondition } from "../common/authz/authz-sql.js";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import {
  bookmarkFolders as sqliteBookmarkFolders,
  bookmarkTags as sqliteBookmarkTags,
  bookmarks as sqliteBookmarks,
  slugPreferences as sqliteSlugPreferences,
} from "../db/schema/index.js";
import {
  bookmarkFolders as pgBookmarkFolders,
  bookmarkTags as pgBookmarkTags,
  bookmarks as pgBookmarks,
  slugPreferences as pgSlugPreferences,
} from "../db/schema/pg-index.js";
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
  bookmarksTable: typeof sqliteBookmarks | typeof pgBookmarks,
): SQL {
  return bookmarkScopeCondition(scope, workspaceId, userId, bookmarksTable);
}

function archivePriorityOrder(
  bookmarksTable: typeof sqliteBookmarks | typeof pgBookmarks,
) {
  return [
    asc(sql`${bookmarksTable.lastAccessedAt} IS NULL`),
    desc(bookmarksTable.lastAccessedAt),
    desc(bookmarksTable.createdAt),
  ];
}

function orderByForSort(
  sort: BookmarkSort,
  bookmarksTable: typeof sqliteBookmarks | typeof pgBookmarks,
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
  bookmarksTable: typeof sqliteBookmarks | typeof pgBookmarks,
  bookmarkFoldersTable: typeof sqliteBookmarkFolders | typeof pgBookmarkFolders,
  bookmarkTagsTable: typeof sqliteBookmarkTags | typeof pgBookmarkTags,
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
      like(bookmarksTable.title, searchPattern),
      like(bookmarksTable.url, searchPattern),
      like(bookmarksTable.slug, searchPattern),
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
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- forwards db + dialect to WorkspaceScopedRepository
  constructor(db: DrizzleClient, dialect: DbDialect) {
    super(db, dialect);
  }

  async create(
    workspaceId: string,
    userId: string,
    data: CreateBookmarkData,
  ): Promise<BookmarkRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteBookmarks)
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
          createdAt: new Date(nowMs),
          updatedAt: new Date(nowMs),
        })
        .run();

      const row = sqliteDb
        .select()
        .from(sqliteBookmarks)
        .where(
          and(
            eq(sqliteBookmarks.id, id),
            eq(sqliteBookmarks.workspaceId, workspaceId),
          ),
        )
        .get();
      return this.assertOwnership(workspaceId, row ? toBookmarkRecord(row) : null);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .insert(pgBookmarks)
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
      this.dialect === "sqlite" ? sqliteBookmarks : pgBookmarks,
    );

    if (this.dialect === "sqlite") {
      const rows = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteBookmarks)
        .where(
          and(
            eq(sqliteBookmarks.workspaceId, workspaceId),
            eq(sqliteBookmarks.planArchived, false),
          ),
        )
        .orderBy(...orderBy)
        .all();
      return rows.map(toBookmarkRecord);
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgBookmarks)
      .where(
        and(
          eq(pgBookmarks.workspaceId, workspaceId),
          eq(pgBookmarks.planArchived, false),
        ),
      )
      .orderBy(...orderBy);
    return rows.map(toBookmarkRecord);
  }

  /** Plan-archived bookmarks ordered for restore selection (def §5). */
  async listPlanArchivedInWorkspaceOrdered(workspaceId: string): Promise<BookmarkRecord[]> {
    const orderBy = archivePriorityOrder(
      this.dialect === "sqlite" ? sqliteBookmarks : pgBookmarks,
    );

    if (this.dialect === "sqlite") {
      const rows = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteBookmarks)
        .where(
          and(
            eq(sqliteBookmarks.workspaceId, workspaceId),
            eq(sqliteBookmarks.planArchived, true),
          ),
        )
        .orderBy(...orderBy)
        .all();
      return rows.map(toBookmarkRecord);
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgBookmarks)
      .where(
        and(
          eq(pgBookmarks.workspaceId, workspaceId),
          eq(pgBookmarks.planArchived, true),
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

    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .update(sqliteBookmarks)
        .set({
          planArchived,
          updatedAt: new Date(nowMs),
        })
        .where(
          and(
            eq(sqliteBookmarks.workspaceId, workspaceId),
            inArray(sqliteBookmarks.id, bookmarkIds),
          ),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .update(pgBookmarks)
      .set({
        planArchived,
        updatedAt: nowMs,
      })
      .where(
        and(
          eq(pgBookmarks.workspaceId, workspaceId),
          inArray(pgBookmarks.id, bookmarkIds),
        ),
      );
  }

  /** Counts non-archived bookmarks in the workspace (spec §12.5 — cap applies to active bookmarks). */
  async countActiveInWorkspace(workspaceId: string): Promise<number> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select({ count: sql<number>`count(*)` })
        .from(sqliteBookmarks)
        .where(
          and(
            eq(sqliteBookmarks.workspaceId, workspaceId),
            eq(sqliteBookmarks.planArchived, false),
          ),
        )
        .get();
      return row?.count ?? 0;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select({ count: sql<number>`count(*)` })
      .from(pgBookmarks)
      .where(
        and(
          eq(pgBookmarks.workspaceId, workspaceId),
          eq(pgBookmarks.planArchived, false),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async findById(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<BookmarkRecord | null> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteBookmarks)
        .where(
          and(
            eq(sqliteBookmarks.id, bookmarkId),
            eq(sqliteBookmarks.workspaceId, workspaceId),
          ),
        )
        .get();
      return row ? toBookmarkRecord(row) : null;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgBookmarks)
      .where(
        and(
          eq(pgBookmarks.id, bookmarkId),
          eq(pgBookmarks.workspaceId, workspaceId),
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
      this.dialect === "sqlite" ? sqliteBookmarks : pgBookmarks,
    );
    const orderByClause = Array.isArray(orderBy) ? orderBy : [orderBy];

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const conditions = buildListConditions(
        workspaceId,
        userId,
        query,
        sqliteBookmarks,
        sqliteBookmarkFolders,
        sqliteBookmarkTags,
      );
      const whereClause = and(...conditions);

      const countRow = sqliteDb
        .select({ count: sql<number>`count(*)` })
        .from(sqliteBookmarks)
        .where(whereClause)
        .get();
      const total = countRow?.count ?? 0;

      const rows = sqliteDb
        .select()
        .from(sqliteBookmarks)
        .where(whereClause)
        .orderBy(...orderByClause)
        .limit(pageSize)
        .offset(offset)
        .all();

      return {
        items: rows.map(toBookmarkRecord),
        total,
        page,
        pageSize,
      };
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const conditions = buildListConditions(
      workspaceId,
      userId,
      query,
      pgBookmarks,
      pgBookmarkFolders,
      pgBookmarkTags,
    );
    const whereClause = and(...conditions);

    const countRows = await pgDb
      .select({ count: sql<number>`count(*)` })
      .from(pgBookmarks)
      .where(whereClause);
    const total = countRows[0]?.count ?? 0;

    const rows = await pgDb
      .select()
      .from(pgBookmarks)
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
      this.dialect === "sqlite" ? sqliteBookmarks : pgBookmarks,
    );
    const orderByClause = Array.isArray(orderBy) ? orderBy : [orderBy];

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const conditions = buildListConditions(
        workspaceId,
        userId,
        query,
        sqliteBookmarks,
        sqliteBookmarkFolders,
        sqliteBookmarkTags,
      );
      const whereClause = and(...conditions);

      const countRow = sqliteDb
        .select({ count: sql<number>`count(*)` })
        .from(sqliteBookmarks)
        .where(whereClause)
        .get();
      const total = countRow?.count ?? 0;

      const rows = sqliteDb
        .select({ id: sqliteBookmarks.id })
        .from(sqliteBookmarks)
        .where(whereClause)
        .orderBy(...orderByClause)
        .all();

      return { ids: rows.map((r) => r.id), total };
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const conditions = buildListConditions(
      workspaceId,
      userId,
      query,
      pgBookmarks,
      pgBookmarkFolders,
      pgBookmarkTags,
    );
    const whereClause = and(...conditions);

    const countRows = await pgDb
      .select({ count: sql<number>`count(*)` })
      .from(pgBookmarks)
      .where(whereClause);
    const total = countRows[0]?.count ?? 0;

    const rows = await pgDb
      .select({ id: pgBookmarks.id })
      .from(pgBookmarks)
      .where(whereClause)
      .orderBy(...orderByClause);

    return { ids: rows.map((r) => r.id), total };
  }

  async findBySlug(
    workspaceId: string,
    slug: string,
  ): Promise<BookmarkRecord | null> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteBookmarks)
        .where(
          and(
            eq(sqliteBookmarks.workspaceId, workspaceId),
            eq(sqliteBookmarks.slug, slug),
          ),
        )
        .get();
      return row ? toBookmarkRecord(row) : null;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgBookmarks)
      .where(
        and(eq(pgBookmarks.workspaceId, workspaceId), eq(pgBookmarks.slug, slug)),
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

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .update(sqliteBookmarks)
        .set({
          ...updates,
          updatedAt: new Date(nowMs),
        })
        .where(
          and(
            eq(sqliteBookmarks.id, bookmarkId),
            eq(sqliteBookmarks.workspaceId, workspaceId),
          ),
        )
        .run();

      return this.findById(workspaceId, bookmarkId);
    }

    await (this.db as PostgresDrizzleClient)
      .update(pgBookmarks)
      .set(updates)
      .where(
        and(
          eq(pgBookmarks.id, bookmarkId),
          eq(pgBookmarks.workspaceId, workspaceId),
        ),
      );

    return this.findById(workspaceId, bookmarkId);
  }

  async delete(workspaceId: string, bookmarkId: string): Promise<void> {
    const sharingRepo = new SharingRepository(this.db, this.dialect);
    await sharingRepo.deleteSharesForBookmark(workspaceId, bookmarkId);
    await this.deleteSlugPreferencesForBookmark(workspaceId, bookmarkId);
    await this.deleteBookmarkFolderLinksForBookmark(workspaceId, bookmarkId);
    await this.deleteBookmarkTagLinksForBookmark(workspaceId, bookmarkId);

    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteBookmarks)
        .where(
          and(
            eq(sqliteBookmarks.id, bookmarkId),
            eq(sqliteBookmarks.workspaceId, workspaceId),
          ),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .delete(pgBookmarks)
      .where(
        and(
          eq(pgBookmarks.id, bookmarkId),
          eq(pgBookmarks.workspaceId, workspaceId),
        ),
      );
  }

  async incrementAccessCount(
    workspaceId: string,
    bookmarkId: string,
    accessedAtMs: number,
  ): Promise<void> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .update(sqliteBookmarks)
        .set({
          accessCount: sql`${sqliteBookmarks.accessCount} + 1`,
          lastAccessedAt: new Date(accessedAtMs),
          updatedAt: new Date(accessedAtMs),
        })
        .where(
          and(
            eq(sqliteBookmarks.id, bookmarkId),
            eq(sqliteBookmarks.workspaceId, workspaceId),
          ),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .update(pgBookmarks)
      .set({
        accessCount: sql`${pgBookmarks.accessCount} + 1`,
        lastAccessedAt: accessedAtMs,
        updatedAt: accessedAtMs,
      })
      .where(
        and(
          eq(pgBookmarks.id, bookmarkId),
          eq(pgBookmarks.workspaceId, workspaceId),
        ),
      );
  }

  async createSlugPreference(
    data: CreateSlugPreferenceData,
  ): Promise<SlugPreferenceRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteSlugPreferences)
        .values({
          id,
          workspaceId: data.workspaceId,
          userId: data.userId,
          slug: data.slug,
          bookmarkId: data.bookmarkId,
          createdAt: new Date(nowMs),
        })
        .run();

      const row = sqliteDb
        .select()
        .from(sqliteSlugPreferences)
        .where(eq(sqliteSlugPreferences.id, id))
        .get();
      if (!row) throw new Error("Failed to create slug preference");
      return toSlugPreferenceRecord(row);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .insert(pgSlugPreferences)
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
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select({ count: sql<number>`count(*)` })
        .from(sqliteSlugPreferences)
        .where(
          and(
            eq(sqliteSlugPreferences.workspaceId, workspaceId),
            eq(sqliteSlugPreferences.bookmarkId, bookmarkId),
          ),
        )
        .get();
      return row?.count ?? 0;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select({ count: sql<number>`count(*)` })
      .from(pgSlugPreferences)
      .where(
        and(
          eq(pgSlugPreferences.workspaceId, workspaceId),
          eq(pgSlugPreferences.bookmarkId, bookmarkId),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  private async deleteBookmarkFolderLinksForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<void> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteBookmarkFolders)
        .where(
          and(
            eq(sqliteBookmarkFolders.workspaceId, workspaceId),
            eq(sqliteBookmarkFolders.bookmarkId, bookmarkId),
          ),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .delete(pgBookmarkFolders)
      .where(
        and(
          eq(pgBookmarkFolders.workspaceId, workspaceId),
          eq(pgBookmarkFolders.bookmarkId, bookmarkId),
        ),
      );
  }

  private async deleteBookmarkTagLinksForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<void> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteBookmarkTags)
        .where(
          and(
            eq(sqliteBookmarkTags.workspaceId, workspaceId),
            eq(sqliteBookmarkTags.bookmarkId, bookmarkId),
          ),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .delete(pgBookmarkTags)
      .where(
        and(
          eq(pgBookmarkTags.workspaceId, workspaceId),
          eq(pgBookmarkTags.bookmarkId, bookmarkId),
        ),
      );
  }

  private async deleteSlugPreferencesForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<void> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteSlugPreferences)
        .where(
          and(
            eq(sqliteSlugPreferences.workspaceId, workspaceId),
            eq(sqliteSlugPreferences.bookmarkId, bookmarkId),
          ),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .delete(pgSlugPreferences)
      .where(
        and(
          eq(pgSlugPreferences.workspaceId, workspaceId),
          eq(pgSlugPreferences.bookmarkId, bookmarkId),
        ),
      );
  }
}
