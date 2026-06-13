import { coerceCount } from "../db/coerce-count.js";
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, ilike, sql, type SQL } from "drizzle-orm";

import { folderScopeCondition } from "../common/authz/authz-sql.js";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import {
  bookmarkFolders,
  folders,
} from "../db/schema/index.js";
import {
  WorkspaceScopedRepository,
  type WorkspaceOwned,
} from "../db/workspace-scoped.repository.js";
import type {
  CreateFolderData,
  FolderRecord,
  ParsedListFoldersQuery,
  PaginatedFolders,
  UpdateFolderData,
} from "./folder.types.js";
import {
  DEFAULT_FOLDER_PAGE_SIZE,
  type FolderScope,
  type FolderSort,
  parsePage,
  parsePageSize,
} from "./folder.validation.js";
import { SharingRepository } from "../sharing/sharing.repository.js";

type FolderRow = WorkspaceOwned & {
  id: string;
  userId: string;
  name: string;
  icon: string | null;
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

function scopeCondition(
  scope: FolderScope,
  userId: string,
  workspaceId: string,
  foldersTable: typeof folders,
): SQL {
  return folderScopeCondition(scope, workspaceId, userId, foldersTable);
}

function orderByForSort(
  sort: FolderSort,
  foldersTable: typeof folders,
) {
  switch (sort) {
    case "name-asc":
      return asc(foldersTable.name);
    case "name-desc":
      return desc(foldersTable.name);
    case "created-asc":
      return asc(foldersTable.createdAt);
    case "created-desc":
    default:
      return desc(foldersTable.createdAt);
  }
}

export class FolderRepository extends WorkspaceScopedRepository<FolderRecord> {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- forwards db to WorkspaceScopedRepository
  constructor(db: DrizzleClient) {
    super(db);
  }

  async create(
    workspaceId: string,
    userId: string,
    data: CreateFolderData,
  ): Promise<FolderRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

        const rows = await this.db
      .insert(folders)
      .values({
        id,
        workspaceId,
        userId,
        name: data.name,
        icon: data.icon ?? null,
        color: data.color ?? null,
        createdAt: nowMs,
        updatedAt: nowMs,
      })
      .returning();
    const row = rows[0];
    const folder = this.assertOwnership(
      workspaceId,
      row ? await this.toFolderRecord(row) : null,
    );
    if (data.bookmarkIds?.length) {
      await this.replaceFolderBookmarks(workspaceId, userId, id, data.bookmarkIds);
      const withLinks = await this.findById(workspaceId, id);
      if (!withLinks) throw new Error("Failed to load folder after bookmark links");
      return withLinks;
    }
    return folder;
  }

  async findById(
    workspaceId: string,
    folderId: string,
  ): Promise<FolderRecord | null> {

    const rows = await this.db
      .select()
      .from(folders)
      .where(
        and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)),
      )
      .limit(1);
    return rows[0] ? await this.toFolderRecord(rows[0]) : null;
  }

  async list(
    workspaceId: string,
    userId: string,
    query: ParsedListFoldersQuery,
  ): Promise<PaginatedFolders> {
    const scope = query.scope;
    const sort = query.sort;
    const page = parsePage(query.page);
    const pageSize = parsePageSize(query.pageSize ?? DEFAULT_FOLDER_PAGE_SIZE);
    const offset = (page - 1) * pageSize;
    const searchPattern =
      query.q && query.q.trim().length > 0
        ? `%${escapeLikePattern(query.q.trim())}%`
        : null;

        const conditions = [
      eq(folders.workspaceId, workspaceId),
      scopeCondition(scope, userId, workspaceId, folders),
    ];
    if (searchPattern) {
      conditions.push(ilike(folders.name, searchPattern));
    }
    const whereClause = and(...conditions);

    const countRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(folders)
      .where(whereClause);
    const total = coerceCount(countRows[0]?.count);

    const rows = await this.db
      .select()
      .from(folders)
      .where(whereClause)
      .orderBy(orderByForSort(sort, folders))
      .limit(pageSize)
      .offset(offset);

    const items = await Promise.all(rows.map((row) => this.toFolderRecord(row)));
    return { items, total, page, pageSize };
  }

  async update(
    workspaceId: string,
    folderId: string,
    patch: UpdateFolderData,
  ): Promise<FolderRecord | null> {
    const nowMs = Date.now();
    const updates: Record<string, unknown> = { updatedAt: nowMs };

    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.icon !== undefined) updates.icon = patch.icon;
    if (patch.color !== undefined) updates.color = patch.color;

    await this.db
      .update(folders)
      .set(updates)
      .where(
        and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)),
      );

    return this.findById(workspaceId, folderId);
  }

  async delete(workspaceId: string, folderId: string): Promise<void> {
    const sharingRepo = new SharingRepository(this.db);
    await sharingRepo.deleteSharesForFolder(workspaceId, folderId);
    await this.deleteBookmarkFolderLinksForFolder(workspaceId, folderId);

    await this.db
      .delete(folders)
      .where(
        and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)),
      );
  }

  async replaceFolderBookmarks(
    workspaceId: string,
    userId: string,
    folderId: string,
    bookmarkIds: string[],
  ): Promise<void> {
    await this.deleteBookmarkFolderLinksForFolder(workspaceId, folderId);

    const uniqueIds = [...new Set(bookmarkIds)];
    for (const bookmarkId of uniqueIds) {
      await this.insertBookmarkFolderLink(workspaceId, userId, folderId, bookmarkId);
    }
  }

  async addBookmarkToFolder(
    workspaceId: string,
    userId: string,
    folderId: string,
    bookmarkId: string,
  ): Promise<void> {
    await this.insertBookmarkFolderLink(workspaceId, userId, folderId, bookmarkId);
  }

  async removeBookmarkFromFolder(
    workspaceId: string,
    folderId: string,
    bookmarkId: string,
  ): Promise<void> {

    await this.db
      .delete(bookmarkFolders)
      .where(
        and(
          eq(bookmarkFolders.workspaceId, workspaceId),
          eq(bookmarkFolders.folderId, folderId),
          eq(bookmarkFolders.bookmarkId, bookmarkId),
        ),
      );
  }

  async countFoldersForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<number> {

    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(bookmarkFolders)
      .where(
        and(
          eq(bookmarkFolders.workspaceId, workspaceId),
          eq(bookmarkFolders.bookmarkId, bookmarkId),
        ),
      );
    return coerceCount(rows[0]?.count);
  }

  async listFolderIdsForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<string[]> {

    const rows = await this.db
      .select({ folderId: bookmarkFolders.folderId })
      .from(bookmarkFolders)
      .where(
        and(
          eq(bookmarkFolders.workspaceId, workspaceId),
          eq(bookmarkFolders.bookmarkId, bookmarkId),
        ),
      );
    return rows.map((r) => r.folderId);
  }

  async deleteBookmarkFolderLinksForBookmark(
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

  private async deleteBookmarkFolderLinksForFolder(
    workspaceId: string,
    folderId: string,
  ): Promise<void> {

    await this.db
      .delete(bookmarkFolders)
      .where(
        and(
          eq(bookmarkFolders.workspaceId, workspaceId),
          eq(bookmarkFolders.folderId, folderId),
        ),
      );
  }

  private async insertBookmarkFolderLink(
    workspaceId: string,
    _userId: string,
    folderId: string,
    bookmarkId: string,
  ): Promise<void> {
    const id = randomUUID();
    const nowMs = Date.now();

    await this.db.insert(bookmarkFolders).values({
      id,
      workspaceId,
      folderId,
      bookmarkId,
      createdAt: nowMs,
    });
  }

  private async countBookmarksInFolder(
    workspaceId: string,
    folderId: string,
  ): Promise<number> {

    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(bookmarkFolders)
      .where(
        and(
          eq(bookmarkFolders.workspaceId, workspaceId),
          eq(bookmarkFolders.folderId, folderId),
        ),
      );
    return coerceCount(rows[0]?.count);
  }

  private async toFolderRecord(row: FolderRow): Promise<FolderRecord> {
    const bookmarkCount = await this.countBookmarksInFolder(
      row.workspaceId,
      row.id,
    );
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      name: row.name,
      icon: row.icon,
      color: row.color,
      bookmarkCount,
      createdAt: toDate(row.createdAt),
      updatedAt: toDate(row.updatedAt),
    };
  }
}
