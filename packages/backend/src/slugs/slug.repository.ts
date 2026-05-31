import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { bookmarkSharedReadCondition } from "../common/authz/authz-sql.js";

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
import type { BookmarkRecord } from "../bookmarks/bookmark.types.js";
import type {
  AccessibleForwardingMatch,
  SlugPreferenceRecord,
  UpsertSlugPreferenceData,
} from "./slug.types.js";

type BookmarkRow = {
  id: string;
  workspaceId: string;
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

export class SlugRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  /**
   * Bookmarks the user can reach via /go for the given slug (spec §8.2).
   */
  async findAccessibleForwardingMatches(
    workspaceId: string,
    userId: string,
    slug: string,
  ): Promise<AccessibleForwardingMatch[]> {
    if (this.dialect === "sqlite") {
      const rows = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteBookmarks)
        .where(
          and(
            eq(sqliteBookmarks.workspaceId, workspaceId),
            eq(sqliteBookmarks.slug, slug),
            eq(sqliteBookmarks.forwardingEnabled, true),
            eq(sqliteBookmarks.planArchived, false),
            bookmarkSharedReadCondition(workspaceId, userId, sqliteBookmarks),
          ),
        )
        .all();
      return rows.map(toBookmarkRecord);
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgBookmarks)
      .where(
        and(
          eq(pgBookmarks.workspaceId, workspaceId),
          eq(pgBookmarks.slug, slug),
          eq(pgBookmarks.forwardingEnabled, true),
          eq(pgBookmarks.planArchived, false),
          bookmarkSharedReadCondition(workspaceId, userId, pgBookmarks),
        ),
      );
    return rows.map(toBookmarkRecord);
  }

  async findSlugPreference(
    workspaceId: string,
    userId: string,
    slug: string,
  ): Promise<SlugPreferenceRecord | null> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteSlugPreferences)
        .where(
          and(
            eq(sqliteSlugPreferences.workspaceId, workspaceId),
            eq(sqliteSlugPreferences.userId, userId),
            eq(sqliteSlugPreferences.slug, slug),
          ),
        )
        .get();
      return row ? toSlugPreferenceRecord(row) : null;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgSlugPreferences)
      .where(
        and(
          eq(pgSlugPreferences.workspaceId, workspaceId),
          eq(pgSlugPreferences.userId, userId),
          eq(pgSlugPreferences.slug, slug),
        ),
      )
      .limit(1);
    return rows[0] ? toSlugPreferenceRecord(rows[0]) : null;
  }

  async listSlugPreferences(
    workspaceId: string,
    userId: string,
  ): Promise<SlugPreferenceRecord[]> {
    if (this.dialect === "sqlite") {
      const rows = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteSlugPreferences)
        .where(
          and(
            eq(sqliteSlugPreferences.workspaceId, workspaceId),
            eq(sqliteSlugPreferences.userId, userId),
          ),
        )
        .all();
      return rows.map(toSlugPreferenceRecord);
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgSlugPreferences)
      .where(
        and(
          eq(pgSlugPreferences.workspaceId, workspaceId),
          eq(pgSlugPreferences.userId, userId),
        ),
      );
    return rows.map(toSlugPreferenceRecord);
  }

  async upsertSlugPreference(
    data: UpsertSlugPreferenceData,
  ): Promise<SlugPreferenceRecord> {
    const existing = await this.findSlugPreference(
      data.workspaceId,
      data.userId,
      data.slug,
    );
    if (existing) {
      return this.updateSlugPreferenceBookmark(
        data.workspaceId,
        data.userId,
        existing.id,
        data.bookmarkId,
      );
    }
    return this.createSlugPreference(data);
  }

  async deleteSlugPreference(
    workspaceId: string,
    userId: string,
    preferenceId: string,
  ): Promise<boolean> {
    if (this.dialect === "sqlite") {
      const result = (this.db as SqliteDrizzleClient)
        .delete(sqliteSlugPreferences)
        .where(
          and(
            eq(sqliteSlugPreferences.id, preferenceId),
            eq(sqliteSlugPreferences.workspaceId, workspaceId),
            eq(sqliteSlugPreferences.userId, userId),
          ),
        )
        .run();
      return result.changes > 0;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .delete(pgSlugPreferences)
      .where(
        and(
          eq(pgSlugPreferences.id, preferenceId),
          eq(pgSlugPreferences.workspaceId, workspaceId),
          eq(pgSlugPreferences.userId, userId),
        ),
      )
      .returning({ id: pgSlugPreferences.id });
    return rows.length > 0;
  }

  private async createSlugPreference(
    data: UpsertSlugPreferenceData,
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

  private async updateSlugPreferenceBookmark(
    workspaceId: string,
    userId: string,
    preferenceId: string,
    bookmarkId: string,
  ): Promise<SlugPreferenceRecord> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .update(sqliteSlugPreferences)
        .set({ bookmarkId })
        .where(
          and(
            eq(sqliteSlugPreferences.id, preferenceId),
            eq(sqliteSlugPreferences.workspaceId, workspaceId),
            eq(sqliteSlugPreferences.userId, userId),
          ),
        )
        .run();

      const row = sqliteDb
        .select()
        .from(sqliteSlugPreferences)
        .where(eq(sqliteSlugPreferences.id, preferenceId))
        .get();
      if (!row) throw new Error("Failed to update slug preference");
      return toSlugPreferenceRecord(row);
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .update(pgSlugPreferences)
      .set({ bookmarkId })
      .where(
        and(
          eq(pgSlugPreferences.id, preferenceId),
          eq(pgSlugPreferences.workspaceId, workspaceId),
          eq(pgSlugPreferences.userId, userId),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to update slug preference");
    return toSlugPreferenceRecord(row);
  }
}
