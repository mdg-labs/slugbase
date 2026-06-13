import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { bookmarkSharedReadCondition } from "../common/authz/authz-sql.js";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import { assertResourceOwnership } from "../common/tenant/resource-ownership.js";
import {
  WorkspaceScopedRepository,
} from "../db/workspace-scoped.repository.js";
import {
  bookmarks,
  slugPreferences,
} from "../db/schema/index.js";
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
    folders: [],
    tags: [],
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

export class SlugRepository extends WorkspaceScopedRepository<SlugPreferenceRecord> {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- forwards db to WorkspaceScopedRepository
  constructor(db: DrizzleClient) {
    super(db);
  }

  /**
   * bookmarks the user can reach via /go for the given slug (spec §8.2).
   */
  async findAccessibleForwardingMatches(
    workspaceId: string,
    userId: string,
    slug: string,
  ): Promise<AccessibleForwardingMatch[]> {

    const rows = await this.db
      .select()
      .from(bookmarks)
      .where(
        and(
          eq(bookmarks.workspaceId, workspaceId),
          eq(bookmarks.slug, slug),
          eq(bookmarks.forwardingEnabled, true),
          eq(bookmarks.planArchived, false),
          bookmarkSharedReadCondition(workspaceId, userId, bookmarks),
        ),
      );
    const records = rows.map(toBookmarkRecord);
    for (const record of records) {
      assertResourceOwnership(workspaceId, record.workspaceId);
    }
    return records;
  }

  async findSlugPreference(
    workspaceId: string,
    userId: string,
    slug: string,
  ): Promise<SlugPreferenceRecord | null> {

    const rows = await this.db
      .select()
      .from(slugPreferences)
      .where(
        and(
          eq(slugPreferences.workspaceId, workspaceId),
          eq(slugPreferences.userId, userId),
          eq(slugPreferences.slug, slug),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return this.assertOwnership(workspaceId, toSlugPreferenceRecord(row));
  }

  async listSlugPreferences(
    workspaceId: string,
    userId: string,
  ): Promise<SlugPreferenceRecord[]> {

    const rows = await this.db
      .select()
      .from(slugPreferences)
      .where(
        and(
          eq(slugPreferences.workspaceId, workspaceId),
          eq(slugPreferences.userId, userId),
        ),
      );
    return this.assertAllOwned(workspaceId, rows.map(toSlugPreferenceRecord));
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

    const rows = await this.db
      .delete(slugPreferences)
      .where(
        and(
          eq(slugPreferences.id, preferenceId),
          eq(slugPreferences.workspaceId, workspaceId),
          eq(slugPreferences.userId, userId),
        ),
      )
      .returning({ id: slugPreferences.id });
    return rows.length > 0;
  }

  async listSlugPreferencesForSlug(
    workspaceId: string,
    slug: string,
  ): Promise<SlugPreferenceRecord[]> {

    const rows = await this.db
      .select()
      .from(slugPreferences)
      .where(
        and(
          eq(slugPreferences.workspaceId, workspaceId),
          eq(slugPreferences.slug, slug),
        ),
      );
    return this.assertAllOwned(workspaceId, rows.map(toSlugPreferenceRecord));
  }

  private async createSlugPreference(
    data: UpsertSlugPreferenceData,
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
    return this.assertOwnership(data.workspaceId, toSlugPreferenceRecord(row));
  }

  private async updateSlugPreferenceBookmark(
    workspaceId: string,
    userId: string,
    preferenceId: string,
    bookmarkId: string,
  ): Promise<SlugPreferenceRecord> {

    const rows = await this.db
      .update(slugPreferences)
      .set({ bookmarkId })
      .where(
        and(
          eq(slugPreferences.id, preferenceId),
          eq(slugPreferences.workspaceId, workspaceId),
          eq(slugPreferences.userId, userId),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to update slug preference");
    return this.assertOwnership(workspaceId, toSlugPreferenceRecord(row));
  }
}
