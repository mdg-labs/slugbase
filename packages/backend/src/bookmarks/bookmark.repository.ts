import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import {
  bookmarks as sqliteBookmarks,
  slugPreferences as sqliteSlugPreferences,
} from "../db/schema/index.js";
import {
  bookmarks as pgBookmarks,
  slugPreferences as pgSlugPreferences,
} from "../db/schema/pg-index.js";
import {
  WorkspaceScopedRepository,
  type WorkspaceOwned,
} from "../db/workspace-scoped.repository.js";
import type {
  BookmarkRecord,
  CreateBookmarkData,
  CreateSlugPreferenceData,
  SlugPreferenceRecord,
  UpdateBookmarkData,
} from "./bookmark.types.js";

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
    await this.deleteSlugPreferencesForBookmark(workspaceId, bookmarkId);

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
