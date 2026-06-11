import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import { WorkspaceScopedRepository } from "../db/workspace-scoped.repository.js";
import {
  bookmarkTeamShares,
  bookmarkUserShares,
  bookmarks,
  folderTeamShares,
  folderUserShares,
  folders,
  teams,
  userAccounts,
} from "../db/schema/index.js";
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

/**
 * Workspace-scoped share grants - every public method requires `workspaceId`
 * as the first argument and filters mutations by workspace (spec §5.9).
 */
export class SharingRepository extends WorkspaceScopedRepository<{
  workspaceId: string;
}> {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- forwards db to WorkspaceScopedRepository
  constructor(db: DrizzleClient) {
    super(db);
  }

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

        await this.db
      .delete(bookmarkUserShares)
      .where(
        and(
          eq(bookmarkUserShares.workspaceId, workspaceId),
          eq(bookmarkUserShares.bookmarkId, bookmarkId),
        ),
      );
    await this.db
      .delete(bookmarkTeamShares)
      .where(
        and(
          eq(bookmarkTeamShares.workspaceId, workspaceId),
          eq(bookmarkTeamShares.bookmarkId, bookmarkId),
        ),
      );
  }

  async deleteSharesForFolder(workspaceId: string, folderId: string): Promise<void> {

        await this.db
      .delete(folderUserShares)
      .where(
        and(
          eq(folderUserShares.workspaceId, workspaceId),
          eq(folderUserShares.folderId, folderId),
        ),
      );
    await this.db
      .delete(folderTeamShares)
      .where(
        and(
          eq(folderTeamShares.workspaceId, workspaceId),
          eq(folderTeamShares.folderId, folderId),
        ),
      );
  }

  async deleteSharesForTeam(workspaceId: string, teamId: string): Promise<void> {

        await this.db
      .delete(bookmarkTeamShares)
      .where(
        and(
          eq(bookmarkTeamShares.workspaceId, workspaceId),
          eq(bookmarkTeamShares.teamId, teamId),
        ),
      );
    await this.db
      .delete(folderTeamShares)
      .where(
        and(
          eq(folderTeamShares.workspaceId, workspaceId),
          eq(folderTeamShares.teamId, teamId),
        ),
      );
  }

  async canReadBookmark(
    workspaceId: string,
    userId: string,
    bookmarkId: string,
  ): Promise<boolean> {

    const rows = await this.db
      .select({ id: bookmarks.id })
      .from(bookmarks)
      .where(
        and(
          eq(bookmarks.workspaceId, workspaceId),
          eq(bookmarks.id, bookmarkId),
          bookmarkSharedReadCondition(workspaceId, userId, bookmarks),
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

    const rows = await this.db
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          eq(folders.workspaceId, workspaceId),
          eq(folders.id, folderId),
          folderSharedReadCondition(workspaceId, userId, folders),
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

        const userRows = await this.db
      .select({ bookmarkId: bookmarkUserShares.bookmarkId })
      .from(bookmarkUserShares)
      .where(
        and(
          eq(bookmarkUserShares.workspaceId, workspaceId),
          inArray(bookmarkUserShares.bookmarkId, bookmarkIds),
        ),
      );
    const teamRows = await this.db
      .select({ bookmarkId: bookmarkTeamShares.bookmarkId })
      .from(bookmarkTeamShares)
      .where(
        and(
          eq(bookmarkTeamShares.workspaceId, workspaceId),
          inArray(bookmarkTeamShares.bookmarkId, bookmarkIds),
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

        const userShares =
      resourceKind === "bookmark"
        ? await this.db
            .select({
              id: bookmarkUserShares.id,
              targetId: bookmarkUserShares.userId,
              targetName: userAccounts.name,
              createdAt: bookmarkUserShares.createdAt,
            })
            .from(bookmarkUserShares)
            .innerJoin(userAccounts, eq(bookmarkUserShares.userId, userAccounts.id))
            .where(
              and(
                eq(bookmarkUserShares.workspaceId, workspaceId),
                eq(bookmarkUserShares.bookmarkId, resourceId),
              ),
            )
        : await this.db
            .select({
              id: folderUserShares.id,
              targetId: folderUserShares.userId,
              targetName: userAccounts.name,
              createdAt: folderUserShares.createdAt,
            })
            .from(folderUserShares)
            .innerJoin(userAccounts, eq(folderUserShares.userId, userAccounts.id))
            .where(
              and(
                eq(folderUserShares.workspaceId, workspaceId),
                eq(folderUserShares.folderId, resourceId),
              ),
            );

    const teamShares =
      resourceKind === "bookmark"
        ? await this.db
            .select({
              id: bookmarkTeamShares.id,
              targetId: bookmarkTeamShares.teamId,
              targetName: teams.name,
              createdAt: bookmarkTeamShares.createdAt,
            })
            .from(bookmarkTeamShares)
            .innerJoin(teams, eq(bookmarkTeamShares.teamId, teams.id))
            .where(
              and(
                eq(bookmarkTeamShares.workspaceId, workspaceId),
                eq(bookmarkTeamShares.bookmarkId, resourceId),
              ),
            )
        : await this.db
            .select({
              id: folderTeamShares.id,
              targetId: folderTeamShares.teamId,
              targetName: teams.name,
              createdAt: folderTeamShares.createdAt,
            })
            .from(folderTeamShares)
            .innerJoin(teams, eq(folderTeamShares.teamId, teams.id))
            .where(
              and(
                eq(folderTeamShares.workspaceId, workspaceId),
                eq(folderTeamShares.folderId, resourceId),
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

        if (resourceKind === "bookmark") {
      const userRows = await this.db
        .delete(bookmarkUserShares)
        .where(
          and(
            eq(bookmarkUserShares.workspaceId, workspaceId),
            eq(bookmarkUserShares.bookmarkId, resourceId),
            eq(bookmarkUserShares.id, grantId),
          ),
        )
        .returning({ id: bookmarkUserShares.id });
      if (userRows.length > 0) return true;
      const teamRows = await this.db
        .delete(bookmarkTeamShares)
        .where(
          and(
            eq(bookmarkTeamShares.workspaceId, workspaceId),
            eq(bookmarkTeamShares.bookmarkId, resourceId),
            eq(bookmarkTeamShares.id, grantId),
          ),
        )
        .returning({ id: bookmarkTeamShares.id });
      return teamRows.length > 0;
    }

    const userRows = await this.db
      .delete(folderUserShares)
      .where(
        and(
          eq(folderUserShares.workspaceId, workspaceId),
          eq(folderUserShares.folderId, resourceId),
          eq(folderUserShares.id, grantId),
        ),
      )
      .returning({ id: folderUserShares.id });
    if (userRows.length > 0) return true;
    const teamRows = await this.db
      .delete(folderTeamShares)
      .where(
        and(
          eq(folderTeamShares.workspaceId, workspaceId),
          eq(folderTeamShares.folderId, resourceId),
          eq(folderTeamShares.id, grantId),
        ),
      )
      .returning({ id: folderTeamShares.id });
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

        switch (kind) {
      case "bookmark-user":
        await this.db
          .insert(bookmarkUserShares)
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
        await this.db
          .insert(bookmarkTeamShares)
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
        await this.db
          .insert(folderUserShares)
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
        await this.db
          .insert(folderTeamShares)
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
