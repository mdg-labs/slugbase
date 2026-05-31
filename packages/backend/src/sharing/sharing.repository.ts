import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

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
  teams as sqliteTeams,
  userAccounts as sqliteUserAccounts,
} from "../db/schema/index.js";
import {
  bookmarkTeamShares as pgBookmarkTeamShares,
  bookmarkUserShares as pgBookmarkUserShares,
  bookmarks as pgBookmarks,
  folderTeamShares as pgFolderTeamShares,
  folderUserShares as pgFolderUserShares,
  folders as pgFolders,
  teams as pgTeams,
  userAccounts as pgUserAccounts,
} from "../db/schema/pg-index.js";
import {
  bookmarkSharedReadCondition,
  folderSharedReadCondition,
} from "../common/authz/authz-sql.js";
import type { ShareGrantKind as ApiShareGrantKind, ShareGrantRecord } from "./sharing.types.js";

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

  async listBookmarkShares(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<ShareGrantRecord[]> {
    return this.listResourceShares("bookmark", workspaceId, bookmarkId);
  }

  async listFolderShares(
    workspaceId: string,
    folderId: string,
  ): Promise<ShareGrantRecord[]> {
    return this.listResourceShares("folder", workspaceId, folderId);
  }

  async findBookmarkShareGrantById(
    workspaceId: string,
    bookmarkId: string,
    grantId: string,
  ): Promise<ShareGrantRecord | null> {
    const grants = await this.listBookmarkShares(workspaceId, bookmarkId);
    return grants.find((grant) => grant.id === grantId) ?? null;
  }

  async findFolderShareGrantById(
    workspaceId: string,
    folderId: string,
    grantId: string,
  ): Promise<ShareGrantRecord | null> {
    const grants = await this.listFolderShares(workspaceId, folderId);
    return grants.find((grant) => grant.id === grantId) ?? null;
  }

  async revokeBookmarkShare(
    workspaceId: string,
    bookmarkId: string,
    grantId: string,
  ): Promise<boolean> {
    return this.revokeResourceShare("bookmark", workspaceId, bookmarkId, grantId);
  }

  async revokeFolderShare(
    workspaceId: string,
    folderId: string,
    grantId: string,
  ): Promise<boolean> {
    return this.revokeResourceShare("folder", workspaceId, folderId, grantId);
  }

  async countBookmarkShareGrants(
    workspaceId: string,
    bookmarkIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (bookmarkIds.length === 0) return counts;

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const userRows = sqliteDb
        .select({
          bookmarkId: sqliteBookmarkUserShares.bookmarkId,
        })
        .from(sqliteBookmarkUserShares)
        .where(
          and(
            eq(sqliteBookmarkUserShares.workspaceId, workspaceId),
            inArray(sqliteBookmarkUserShares.bookmarkId, bookmarkIds),
          ),
        )
        .all();
      const teamRows = sqliteDb
        .select({
          bookmarkId: sqliteBookmarkTeamShares.bookmarkId,
        })
        .from(sqliteBookmarkTeamShares)
        .where(
          and(
            eq(sqliteBookmarkTeamShares.workspaceId, workspaceId),
            inArray(sqliteBookmarkTeamShares.bookmarkId, bookmarkIds),
          ),
        )
        .all();
      for (const row of [...userRows, ...teamRows]) {
        counts.set(row.bookmarkId, (counts.get(row.bookmarkId) ?? 0) + 1);
      }
      return counts;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const userRows = await pgDb
      .select({ bookmarkId: pgBookmarkUserShares.bookmarkId })
      .from(pgBookmarkUserShares)
      .where(
        and(
          eq(pgBookmarkUserShares.workspaceId, workspaceId),
          inArray(pgBookmarkUserShares.bookmarkId, bookmarkIds),
        ),
      );
    const teamRows = await pgDb
      .select({ bookmarkId: pgBookmarkTeamShares.bookmarkId })
      .from(pgBookmarkTeamShares)
      .where(
        and(
          eq(pgBookmarkTeamShares.workspaceId, workspaceId),
          inArray(pgBookmarkTeamShares.bookmarkId, bookmarkIds),
        ),
      );
    for (const row of [...userRows, ...teamRows]) {
      counts.set(row.bookmarkId, (counts.get(row.bookmarkId) ?? 0) + 1);
    }
    return counts;
  }

  private async listResourceShares(
    resourceKind: "bookmark" | "folder",
    workspaceId: string,
    resourceId: string,
  ): Promise<ShareGrantRecord[]> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const userShares =
        resourceKind === "bookmark"
          ? sqliteDb
              .select({
                id: sqliteBookmarkUserShares.id,
                targetId: sqliteBookmarkUserShares.userId,
                targetName: sqliteUserAccounts.name,
                createdAt: sqliteBookmarkUserShares.createdAt,
              })
              .from(sqliteBookmarkUserShares)
              .innerJoin(
                sqliteUserAccounts,
                eq(sqliteBookmarkUserShares.userId, sqliteUserAccounts.id),
              )
              .where(
                and(
                  eq(sqliteBookmarkUserShares.workspaceId, workspaceId),
                  eq(sqliteBookmarkUserShares.bookmarkId, resourceId),
                ),
              )
              .all()
          : sqliteDb
              .select({
                id: sqliteFolderUserShares.id,
                targetId: sqliteFolderUserShares.userId,
                targetName: sqliteUserAccounts.name,
                createdAt: sqliteFolderUserShares.createdAt,
              })
              .from(sqliteFolderUserShares)
              .innerJoin(
                sqliteUserAccounts,
                eq(sqliteFolderUserShares.userId, sqliteUserAccounts.id),
              )
              .where(
                and(
                  eq(sqliteFolderUserShares.workspaceId, workspaceId),
                  eq(sqliteFolderUserShares.folderId, resourceId),
                ),
              )
              .all();

      const teamShares =
        resourceKind === "bookmark"
          ? sqliteDb
              .select({
                id: sqliteBookmarkTeamShares.id,
                targetId: sqliteBookmarkTeamShares.teamId,
                targetName: sqliteTeams.name,
                createdAt: sqliteBookmarkTeamShares.createdAt,
              })
              .from(sqliteBookmarkTeamShares)
              .innerJoin(
                sqliteTeams,
                eq(sqliteBookmarkTeamShares.teamId, sqliteTeams.id),
              )
              .where(
                and(
                  eq(sqliteBookmarkTeamShares.workspaceId, workspaceId),
                  eq(sqliteBookmarkTeamShares.bookmarkId, resourceId),
                ),
              )
              .all()
          : sqliteDb
              .select({
                id: sqliteFolderTeamShares.id,
                targetId: sqliteFolderTeamShares.teamId,
                targetName: sqliteTeams.name,
                createdAt: sqliteFolderTeamShares.createdAt,
              })
              .from(sqliteFolderTeamShares)
              .innerJoin(
                sqliteTeams,
                eq(sqliteFolderTeamShares.teamId, sqliteTeams.id),
              )
              .where(
                and(
                  eq(sqliteFolderTeamShares.workspaceId, workspaceId),
                  eq(sqliteFolderTeamShares.folderId, resourceId),
                ),
              )
              .all();

      return [
        ...userShares.map((row) => this.toShareGrant("user", row)),
        ...teamShares.map((row) => this.toShareGrant("team", row)),
      ];
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const userShares =
      resourceKind === "bookmark"
        ? await pgDb
            .select({
              id: pgBookmarkUserShares.id,
              targetId: pgBookmarkUserShares.userId,
              targetName: pgUserAccounts.name,
              createdAt: pgBookmarkUserShares.createdAt,
            })
            .from(pgBookmarkUserShares)
            .innerJoin(pgUserAccounts, eq(pgBookmarkUserShares.userId, pgUserAccounts.id))
            .where(
              and(
                eq(pgBookmarkUserShares.workspaceId, workspaceId),
                eq(pgBookmarkUserShares.bookmarkId, resourceId),
              ),
            )
        : await pgDb
            .select({
              id: pgFolderUserShares.id,
              targetId: pgFolderUserShares.userId,
              targetName: pgUserAccounts.name,
              createdAt: pgFolderUserShares.createdAt,
            })
            .from(pgFolderUserShares)
            .innerJoin(pgUserAccounts, eq(pgFolderUserShares.userId, pgUserAccounts.id))
            .where(
              and(
                eq(pgFolderUserShares.workspaceId, workspaceId),
                eq(pgFolderUserShares.folderId, resourceId),
              ),
            );

    const teamShares =
      resourceKind === "bookmark"
        ? await pgDb
            .select({
              id: pgBookmarkTeamShares.id,
              targetId: pgBookmarkTeamShares.teamId,
              targetName: pgTeams.name,
              createdAt: pgBookmarkTeamShares.createdAt,
            })
            .from(pgBookmarkTeamShares)
            .innerJoin(pgTeams, eq(pgBookmarkTeamShares.teamId, pgTeams.id))
            .where(
              and(
                eq(pgBookmarkTeamShares.workspaceId, workspaceId),
                eq(pgBookmarkTeamShares.bookmarkId, resourceId),
              ),
            )
        : await pgDb
            .select({
              id: pgFolderTeamShares.id,
              targetId: pgFolderTeamShares.teamId,
              targetName: pgTeams.name,
              createdAt: pgFolderTeamShares.createdAt,
            })
            .from(pgFolderTeamShares)
            .innerJoin(pgTeams, eq(pgFolderTeamShares.teamId, pgTeams.id))
            .where(
              and(
                eq(pgFolderTeamShares.workspaceId, workspaceId),
                eq(pgFolderTeamShares.folderId, resourceId),
              ),
            );

    return [
      ...userShares.map((row) => this.toShareGrant("user", row)),
      ...teamShares.map((row) => this.toShareGrant("team", row)),
    ];
  }

  private async revokeResourceShare(
    resourceKind: "bookmark" | "folder",
    workspaceId: string,
    resourceId: string,
    grantId: string,
  ): Promise<boolean> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      if (resourceKind === "bookmark") {
        const userResult = sqliteDb
          .delete(sqliteBookmarkUserShares)
          .where(
            and(
              eq(sqliteBookmarkUserShares.workspaceId, workspaceId),
              eq(sqliteBookmarkUserShares.bookmarkId, resourceId),
              eq(sqliteBookmarkUserShares.id, grantId),
            ),
          )
          .run();
        if (userResult.changes > 0) return true;
        const teamResult = sqliteDb
          .delete(sqliteBookmarkTeamShares)
          .where(
            and(
              eq(sqliteBookmarkTeamShares.workspaceId, workspaceId),
              eq(sqliteBookmarkTeamShares.bookmarkId, resourceId),
              eq(sqliteBookmarkTeamShares.id, grantId),
            ),
          )
          .run();
        return teamResult.changes > 0;
      }

      const userResult = sqliteDb
        .delete(sqliteFolderUserShares)
        .where(
          and(
            eq(sqliteFolderUserShares.workspaceId, workspaceId),
            eq(sqliteFolderUserShares.folderId, resourceId),
            eq(sqliteFolderUserShares.id, grantId),
          ),
        )
        .run();
      if (userResult.changes > 0) return true;
      const teamResult = sqliteDb
        .delete(sqliteFolderTeamShares)
        .where(
          and(
            eq(sqliteFolderTeamShares.workspaceId, workspaceId),
            eq(sqliteFolderTeamShares.folderId, resourceId),
            eq(sqliteFolderTeamShares.id, grantId),
          ),
        )
        .run();
      return teamResult.changes > 0;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    if (resourceKind === "bookmark") {
      const userRows = await pgDb
        .delete(pgBookmarkUserShares)
        .where(
          and(
            eq(pgBookmarkUserShares.workspaceId, workspaceId),
            eq(pgBookmarkUserShares.bookmarkId, resourceId),
            eq(pgBookmarkUserShares.id, grantId),
          ),
        )
        .returning({ id: pgBookmarkUserShares.id });
      if (userRows.length > 0) return true;
      const teamRows = await pgDb
        .delete(pgBookmarkTeamShares)
        .where(
          and(
            eq(pgBookmarkTeamShares.workspaceId, workspaceId),
            eq(pgBookmarkTeamShares.bookmarkId, resourceId),
            eq(pgBookmarkTeamShares.id, grantId),
          ),
        )
        .returning({ id: pgBookmarkTeamShares.id });
      return teamRows.length > 0;
    }

    const userRows = await pgDb
      .delete(pgFolderUserShares)
      .where(
        and(
          eq(pgFolderUserShares.workspaceId, workspaceId),
          eq(pgFolderUserShares.folderId, resourceId),
          eq(pgFolderUserShares.id, grantId),
        ),
      )
      .returning({ id: pgFolderUserShares.id });
    if (userRows.length > 0) return true;
    const teamRows = await pgDb
      .delete(pgFolderTeamShares)
      .where(
        and(
          eq(pgFolderTeamShares.workspaceId, workspaceId),
          eq(pgFolderTeamShares.folderId, resourceId),
          eq(pgFolderTeamShares.id, grantId),
        ),
      )
      .returning({ id: pgFolderTeamShares.id });
    return teamRows.length > 0;
  }

  private toShareGrant(
    kind: ApiShareGrantKind,
    row: {
      id: string;
      targetId: string;
      targetName: string;
      createdAt: Date | number;
    },
  ): ShareGrantRecord {
    return {
      id: row.id,
      kind,
      targetId: row.targetId,
      targetName: row.targetName,
      createdAt:
        row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    };
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
