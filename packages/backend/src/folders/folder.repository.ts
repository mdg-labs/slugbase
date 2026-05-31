import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, like, sql, type SQL } from "drizzle-orm";

import { folderScopeCondition } from "../common/authz/authz-sql.js";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import {
  bookmarkFolders as sqliteBookmarkFolders,
  folders as sqliteFolders,
} from "../db/schema/index.js";
import {
  bookmarkFolders as pgBookmarkFolders,
  folders as pgFolders,
} from "../db/schema/pg-index.js";
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
  foldersTable: typeof sqliteFolders | typeof pgFolders,
): SQL {
  return folderScopeCondition(scope, workspaceId, userId, foldersTable);
}

function orderByForSort(
  sort: FolderSort,
  foldersTable: typeof sqliteFolders | typeof pgFolders,
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
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- forwards db + dialect
  constructor(db: DrizzleClient, dialect: DbDialect) {
    super(db, dialect);
  }

  async create(
    workspaceId: string,
    userId: string,
    data: CreateFolderData,
  ): Promise<FolderRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteFolders)
        .values({
          id,
          workspaceId,
          userId,
          name: data.name,
          icon: data.icon ?? null,
          createdAt: new Date(nowMs),
          updatedAt: new Date(nowMs),
        })
        .run();

      const row = sqliteDb
        .select()
        .from(sqliteFolders)
        .where(
          and(eq(sqliteFolders.id, id), eq(sqliteFolders.workspaceId, workspaceId)),
        )
        .get();
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

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .insert(pgFolders)
      .values({
        id,
        workspaceId,
        userId,
        name: data.name,
        icon: data.icon ?? null,
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
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteFolders)
        .where(
          and(
            eq(sqliteFolders.id, folderId),
            eq(sqliteFolders.workspaceId, workspaceId),
          ),
        )
        .get();
      return row ? await this.toFolderRecord(row) : null;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgFolders)
      .where(
        and(eq(pgFolders.id, folderId), eq(pgFolders.workspaceId, workspaceId)),
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

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const conditions = [
        eq(sqliteFolders.workspaceId, workspaceId),
        scopeCondition(scope, userId, workspaceId, sqliteFolders),
      ];
      if (searchPattern) {
        conditions.push(like(sqliteFolders.name, searchPattern));
      }

      const whereClause = and(...conditions);

      const countRow = sqliteDb
        .select({ count: sql<number>`count(*)` })
        .from(sqliteFolders)
        .where(whereClause)
        .get();
      const total = countRow?.count ?? 0;

      const rows = sqliteDb
        .select()
        .from(sqliteFolders)
        .where(whereClause)
        .orderBy(orderByForSort(sort, sqliteFolders))
        .limit(pageSize)
        .offset(offset)
        .all();

      const items = await Promise.all(rows.map((row) => this.toFolderRecord(row)));
      return { items, total, page, pageSize };
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const conditions = [
      eq(pgFolders.workspaceId, workspaceId),
      scopeCondition(scope, userId, workspaceId, pgFolders),
    ];
    if (searchPattern) {
      conditions.push(like(pgFolders.name, searchPattern));
    }
    const whereClause = and(...conditions);

    const countRows = await pgDb
      .select({ count: sql<number>`count(*)` })
      .from(pgFolders)
      .where(whereClause);
    const total = countRows[0]?.count ?? 0;

    const rows = await pgDb
      .select()
      .from(pgFolders)
      .where(whereClause)
      .orderBy(orderByForSort(sort, pgFolders))
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

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .update(sqliteFolders)
        .set({
          ...updates,
          updatedAt: new Date(nowMs),
        })
        .where(
          and(
            eq(sqliteFolders.id, folderId),
            eq(sqliteFolders.workspaceId, workspaceId),
          ),
        )
        .run();
      return this.findById(workspaceId, folderId);
    }

    await (this.db as PostgresDrizzleClient)
      .update(pgFolders)
      .set(updates)
      .where(
        and(eq(pgFolders.id, folderId), eq(pgFolders.workspaceId, workspaceId)),
      );

    return this.findById(workspaceId, folderId);
  }

  async delete(workspaceId: string, folderId: string): Promise<void> {
    const sharingRepo = new SharingRepository(this.db, this.dialect);
    await sharingRepo.deleteSharesForFolder(workspaceId, folderId);
    await this.deleteBookmarkFolderLinksForFolder(workspaceId, folderId);

    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteFolders)
        .where(
          and(
            eq(sqliteFolders.id, folderId),
            eq(sqliteFolders.workspaceId, workspaceId),
          ),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .delete(pgFolders)
      .where(
        and(eq(pgFolders.id, folderId), eq(pgFolders.workspaceId, workspaceId)),
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
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteBookmarkFolders)
        .where(
          and(
            eq(sqliteBookmarkFolders.workspaceId, workspaceId),
            eq(sqliteBookmarkFolders.folderId, folderId),
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
          eq(pgBookmarkFolders.folderId, folderId),
          eq(pgBookmarkFolders.bookmarkId, bookmarkId),
        ),
      );
  }

  async countFoldersForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<number> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select({ count: sql<number>`count(*)` })
        .from(sqliteBookmarkFolders)
        .where(
          and(
            eq(sqliteBookmarkFolders.workspaceId, workspaceId),
            eq(sqliteBookmarkFolders.bookmarkId, bookmarkId),
          ),
        )
        .get();
      return row?.count ?? 0;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select({ count: sql<number>`count(*)` })
      .from(pgBookmarkFolders)
      .where(
        and(
          eq(pgBookmarkFolders.workspaceId, workspaceId),
          eq(pgBookmarkFolders.bookmarkId, bookmarkId),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async listFolderIdsForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<string[]> {
    if (this.dialect === "sqlite") {
      const rows = (this.db as SqliteDrizzleClient)
        .select({ folderId: sqliteBookmarkFolders.folderId })
        .from(sqliteBookmarkFolders)
        .where(
          and(
            eq(sqliteBookmarkFolders.workspaceId, workspaceId),
            eq(sqliteBookmarkFolders.bookmarkId, bookmarkId),
          ),
        )
        .all();
      return rows.map((r) => r.folderId);
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select({ folderId: pgBookmarkFolders.folderId })
      .from(pgBookmarkFolders)
      .where(
        and(
          eq(pgBookmarkFolders.workspaceId, workspaceId),
          eq(pgBookmarkFolders.bookmarkId, bookmarkId),
        ),
      );
    return rows.map((r) => r.folderId);
  }

  async deleteBookmarkFolderLinksForBookmark(
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

  private async deleteBookmarkFolderLinksForFolder(
    workspaceId: string,
    folderId: string,
  ): Promise<void> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteBookmarkFolders)
        .where(
          and(
            eq(sqliteBookmarkFolders.workspaceId, workspaceId),
            eq(sqliteBookmarkFolders.folderId, folderId),
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
          eq(pgBookmarkFolders.folderId, folderId),
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

    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .insert(sqliteBookmarkFolders)
        .values({
          id,
          workspaceId,
          folderId,
          bookmarkId,
          createdAt: new Date(nowMs),
        })
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient).insert(pgBookmarkFolders).values({
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
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select({ count: sql<number>`count(*)` })
        .from(sqliteBookmarkFolders)
        .where(
          and(
            eq(sqliteBookmarkFolders.workspaceId, workspaceId),
            eq(sqliteBookmarkFolders.folderId, folderId),
          ),
        )
        .get();
      return row?.count ?? 0;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select({ count: sql<number>`count(*)` })
      .from(pgBookmarkFolders)
      .where(
        and(
          eq(pgBookmarkFolders.workspaceId, workspaceId),
          eq(pgBookmarkFolders.folderId, folderId),
        ),
      );
    return rows[0]?.count ?? 0;
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
      bookmarkCount,
      createdAt: toDate(row.createdAt),
      updatedAt: toDate(row.updatedAt),
    };
  }
}
