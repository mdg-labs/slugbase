import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import {
  bookmarkTeamShares as sqliteBookmarkTeamShares,
  bookmarkUserShares as sqliteBookmarkUserShares,
  bookmarks as sqliteBookmarks,
  folderTeamShares as sqliteFolderTeamShares,
  folderUserShares as sqliteFolderUserShares,
  folders as sqliteFolders,
} from "../db/schema/index.js";
import {
  bookmarkTeamShares as pgBookmarkTeamShares,
  bookmarkUserShares as pgBookmarkUserShares,
  bookmarks as pgBookmarks,
  folderTeamShares as pgFolderTeamShares,
  folderUserShares as pgFolderUserShares,
  folders as pgFolders,
} from "../db/schema/pg-index.js";
import {
  bookmarkSharedReadCondition,
  folderSharedReadCondition,
} from "../common/authz/authz-sql.js";

export type ShareGrantKind = "bookmark-user" | "bookmark-team" | "folder-user" | "folder-team";

export interface ShareGrantInput {
  kind: ShareGrantKind;
  resourceId: string;
  granteeId: string;
}

export class SharingRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async grantBookmarkUserShare(
    workspaceId: string,
    bookmarkId: string,
    userId: string,
  ): Promise<void> {
    await this.insertShare("bookmark-user", workspaceId, bookmarkId, userId);
  }

  async grantBookmarkTeamShare(
    workspaceId: string,
    bookmarkId: string,
    teamId: string,
  ): Promise<void> {
    await this.insertShare("bookmark-team", workspaceId, bookmarkId, teamId);
  }

  async grantFolderUserShare(
    workspaceId: string,
    folderId: string,
    userId: string,
  ): Promise<void> {
    await this.insertShare("folder-user", workspaceId, folderId, userId);
  }

  async grantFolderTeamShare(
    workspaceId: string,
    folderId: string,
    teamId: string,
  ): Promise<void> {
    await this.insertShare("folder-team", workspaceId, folderId, teamId);
  }

  async deleteSharesForBookmark(workspaceId: string, bookmarkId: string): Promise<void> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .delete(sqliteBookmarkUserShares)
        .where(
          and(
            eq(sqliteBookmarkUserShares.workspaceId, workspaceId),
            eq(sqliteBookmarkUserShares.bookmarkId, bookmarkId),
          ),
        )
        .run();
      sqliteDb
        .delete(sqliteBookmarkTeamShares)
        .where(
          and(
            eq(sqliteBookmarkTeamShares.workspaceId, workspaceId),
            eq(sqliteBookmarkTeamShares.bookmarkId, bookmarkId),
          ),
        )
        .run();
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb
      .delete(pgBookmarkUserShares)
      .where(
        and(
          eq(pgBookmarkUserShares.workspaceId, workspaceId),
          eq(pgBookmarkUserShares.bookmarkId, bookmarkId),
        ),
      );
    await pgDb
      .delete(pgBookmarkTeamShares)
      .where(
        and(
          eq(pgBookmarkTeamShares.workspaceId, workspaceId),
          eq(pgBookmarkTeamShares.bookmarkId, bookmarkId),
        ),
      );
  }

  async deleteSharesForFolder(workspaceId: string, folderId: string): Promise<void> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .delete(sqliteFolderUserShares)
        .where(
          and(
            eq(sqliteFolderUserShares.workspaceId, workspaceId),
            eq(sqliteFolderUserShares.folderId, folderId),
          ),
        )
        .run();
      sqliteDb
        .delete(sqliteFolderTeamShares)
        .where(
          and(
            eq(sqliteFolderTeamShares.workspaceId, workspaceId),
            eq(sqliteFolderTeamShares.folderId, folderId),
          ),
        )
        .run();
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb
      .delete(pgFolderUserShares)
      .where(
        and(
          eq(pgFolderUserShares.workspaceId, workspaceId),
          eq(pgFolderUserShares.folderId, folderId),
        ),
      );
    await pgDb
      .delete(pgFolderTeamShares)
      .where(
        and(
          eq(pgFolderTeamShares.workspaceId, workspaceId),
          eq(pgFolderTeamShares.folderId, folderId),
        ),
      );
  }

  async deleteSharesForTeam(workspaceId: string, teamId: string): Promise<void> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .delete(sqliteBookmarkTeamShares)
        .where(
          and(
            eq(sqliteBookmarkTeamShares.workspaceId, workspaceId),
            eq(sqliteBookmarkTeamShares.teamId, teamId),
          ),
        )
        .run();
      sqliteDb
        .delete(sqliteFolderTeamShares)
        .where(
          and(
            eq(sqliteFolderTeamShares.workspaceId, workspaceId),
            eq(sqliteFolderTeamShares.teamId, teamId),
          ),
        )
        .run();
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb
      .delete(pgBookmarkTeamShares)
      .where(
        and(
          eq(pgBookmarkTeamShares.workspaceId, workspaceId),
          eq(pgBookmarkTeamShares.teamId, teamId),
        ),
      );
    await pgDb
      .delete(pgFolderTeamShares)
      .where(
        and(
          eq(pgFolderTeamShares.workspaceId, workspaceId),
          eq(pgFolderTeamShares.teamId, teamId),
        ),
      );
  }

  async canReadBookmark(
    workspaceId: string,
    userId: string,
    bookmarkId: string,
  ): Promise<boolean> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select({ id: sqliteBookmarks.id })
        .from(sqliteBookmarks)
        .where(
          and(
            eq(sqliteBookmarks.workspaceId, workspaceId),
            eq(sqliteBookmarks.id, bookmarkId),
            bookmarkSharedReadCondition(workspaceId, userId, sqliteBookmarks),
          ),
        )
        .get();
      return row != null;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select({ id: pgBookmarks.id })
      .from(pgBookmarks)
      .where(
        and(
          eq(pgBookmarks.workspaceId, workspaceId),
          eq(pgBookmarks.id, bookmarkId),
          bookmarkSharedReadCondition(workspaceId, userId, pgBookmarks),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async canReadFolder(
    workspaceId: string,
    userId: string,
    folderId: string,
  ): Promise<boolean> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select({ id: sqliteFolders.id })
        .from(sqliteFolders)
        .where(
          and(
            eq(sqliteFolders.workspaceId, workspaceId),
            eq(sqliteFolders.id, folderId),
            folderSharedReadCondition(workspaceId, userId, sqliteFolders),
          ),
        )
        .get();
      return row != null;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select({ id: pgFolders.id })
      .from(pgFolders)
      .where(
        and(
          eq(pgFolders.workspaceId, workspaceId),
          eq(pgFolders.id, folderId),
          folderSharedReadCondition(workspaceId, userId, pgFolders),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  private async insertShare(
    kind: ShareGrantKind,
    workspaceId: string,
    resourceId: string,
    granteeId: string,
  ): Promise<void> {
    const id = randomUUID();
    const nowMs = Date.now();

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      switch (kind) {
        case "bookmark-user":
          sqliteDb
            .insert(sqliteBookmarkUserShares)
            .values({
              id,
              workspaceId,
              bookmarkId: resourceId,
              userId: granteeId,
              createdAt: new Date(nowMs),
            })
            .onConflictDoNothing()
            .run();
          break;
        case "bookmark-team":
          sqliteDb
            .insert(sqliteBookmarkTeamShares)
            .values({
              id,
              workspaceId,
              bookmarkId: resourceId,
              teamId: granteeId,
              createdAt: new Date(nowMs),
            })
            .onConflictDoNothing()
            .run();
          break;
        case "folder-user":
          sqliteDb
            .insert(sqliteFolderUserShares)
            .values({
              id,
              workspaceId,
              folderId: resourceId,
              userId: granteeId,
              createdAt: new Date(nowMs),
            })
            .onConflictDoNothing()
            .run();
          break;
        case "folder-team":
          sqliteDb
            .insert(sqliteFolderTeamShares)
            .values({
              id,
              workspaceId,
              folderId: resourceId,
              teamId: granteeId,
              createdAt: new Date(nowMs),
            })
            .onConflictDoNothing()
            .run();
          break;
      }
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    switch (kind) {
      case "bookmark-user":
        await pgDb
          .insert(pgBookmarkUserShares)
          .values({
            id,
            workspaceId,
            bookmarkId: resourceId,
            userId: granteeId,
            createdAt: nowMs,
          })
          .onConflictDoNothing();
        break;
      case "bookmark-team":
        await pgDb
          .insert(pgBookmarkTeamShares)
          .values({
            id,
            workspaceId,
            bookmarkId: resourceId,
            teamId: granteeId,
            createdAt: nowMs,
          })
          .onConflictDoNothing();
        break;
      case "folder-user":
        await pgDb
          .insert(pgFolderUserShares)
          .values({
            id,
            workspaceId,
            folderId: resourceId,
            userId: granteeId,
            createdAt: nowMs,
          })
          .onConflictDoNothing();
        break;
      case "folder-team":
        await pgDb
          .insert(pgFolderTeamShares)
          .values({
            id,
            workspaceId,
            folderId: resourceId,
            teamId: granteeId,
            createdAt: nowMs,
          })
          .onConflictDoNothing();
        break;
    }
  }
}
