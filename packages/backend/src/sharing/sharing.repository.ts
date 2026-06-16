import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import { WorkspaceScopedRepository } from "../db/workspace-scoped.repository.js";
import {
  bookmarkFolders,
  bookmarkTeamShares,
  bookmarkUserShares,
  bookmarks,
  folderTeamShares,
  folderUserShares,
  folders,
  teamMemberships,
  teams,
  userAccounts,
} from "../db/schema/index.js";
import {
  bookmarkSharedReadCondition,
  folderSharedReadCondition,
} from "../common/authz/authz-sql.js";
import type { ShareGrantKind as ApiShareGrantKind, ShareGrantRecord } from "./sharing.types.js";
import type {
  AccessPathCandidate,
  DirectShareRow,
  ViaFolderShareRow,
} from "./sharing-summary.assembler.js";

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

  async batchListDirectBookmarkShares(
    workspaceId: string,
    bookmarkIds: string[],
  ): Promise<DirectShareRow[]> {
    if (bookmarkIds.length === 0) return [];

    const userRows = await this.db
      .select({
        bookmarkId: bookmarkUserShares.bookmarkId,
        targetId: bookmarkUserShares.userId,
        targetName: userAccounts.name,
      })
      .from(bookmarkUserShares)
      .innerJoin(userAccounts, eq(bookmarkUserShares.userId, userAccounts.id))
      .where(
        and(
          eq(bookmarkUserShares.workspaceId, workspaceId),
          inArray(bookmarkUserShares.bookmarkId, bookmarkIds),
        ),
      );

    const teamRows = await this.db
      .select({
        bookmarkId: bookmarkTeamShares.bookmarkId,
        targetId: bookmarkTeamShares.teamId,
        targetName: teams.name,
      })
      .from(bookmarkTeamShares)
      .innerJoin(teams, eq(bookmarkTeamShares.teamId, teams.id))
      .where(
        and(
          eq(bookmarkTeamShares.workspaceId, workspaceId),
          inArray(bookmarkTeamShares.bookmarkId, bookmarkIds),
        ),
      );

    return [
      ...userRows.map((row) => ({
        bookmarkId: row.bookmarkId,
        recipient: {
          kind: "user" as const,
          targetId: row.targetId,
          targetName: row.targetName,
        },
      })),
      ...teamRows.map((row) => ({
        bookmarkId: row.bookmarkId,
        recipient: {
          kind: "team" as const,
          targetId: row.targetId,
          targetName: row.targetName,
        },
      })),
    ];
  }

  async batchListFolderTransitiveShares(
    workspaceId: string,
    bookmarkIds: string[],
  ): Promise<ViaFolderShareRow[]> {
    if (bookmarkIds.length === 0) return [];

    const userRows = await this.db
      .select({
        bookmarkId: bookmarkFolders.bookmarkId,
        folderId: folders.id,
        folderName: folders.name,
        targetId: folderUserShares.userId,
        targetName: userAccounts.name,
      })
      .from(bookmarkFolders)
      .innerJoin(
        folders,
        and(
          eq(bookmarkFolders.folderId, folders.id),
          eq(bookmarkFolders.workspaceId, workspaceId),
        ),
      )
      .innerJoin(
        folderUserShares,
        and(
          eq(folderUserShares.folderId, folders.id),
          eq(folderUserShares.workspaceId, workspaceId),
        ),
      )
      .innerJoin(userAccounts, eq(folderUserShares.userId, userAccounts.id))
      .where(
        and(
          eq(bookmarkFolders.workspaceId, workspaceId),
          inArray(bookmarkFolders.bookmarkId, bookmarkIds),
        ),
      );

    const teamRows = await this.db
      .select({
        bookmarkId: bookmarkFolders.bookmarkId,
        folderId: folders.id,
        folderName: folders.name,
        targetId: folderTeamShares.teamId,
        targetName: teams.name,
      })
      .from(bookmarkFolders)
      .innerJoin(
        folders,
        and(
          eq(bookmarkFolders.folderId, folders.id),
          eq(bookmarkFolders.workspaceId, workspaceId),
        ),
      )
      .innerJoin(
        folderTeamShares,
        and(
          eq(folderTeamShares.folderId, folders.id),
          eq(folderTeamShares.workspaceId, workspaceId),
        ),
      )
      .innerJoin(teams, eq(folderTeamShares.teamId, teams.id))
      .where(
        and(
          eq(bookmarkFolders.workspaceId, workspaceId),
          inArray(bookmarkFolders.bookmarkId, bookmarkIds),
        ),
      );

    return [
      ...userRows.map((row) => ({
        bookmarkId: row.bookmarkId,
        folderId: row.folderId,
        folderName: row.folderName,
        recipient: {
          kind: "user" as const,
          targetId: row.targetId,
          targetName: row.targetName,
        },
      })),
      ...teamRows.map((row) => ({
        bookmarkId: row.bookmarkId,
        folderId: row.folderId,
        folderName: row.folderName,
        recipient: {
          kind: "team" as const,
          targetId: row.targetId,
          targetName: row.targetName,
        },
      })),
    ];
  }

  async batchResolveAccessPaths(
    workspaceId: string,
    viewerUserId: string,
    bookmarkRefs: Array<{ bookmarkId: string; ownerUserId: string }>,
  ): Promise<AccessPathCandidate[]> {
    if (bookmarkRefs.length === 0) return [];

    const bookmarkIds = bookmarkRefs.map((ref) => ref.bookmarkId);
    const ownerNameByUserId = await this.fetchOwnerNames(
      bookmarkRefs.map((ref) => ref.ownerUserId),
    );

    const directUserRows = await this.db
      .select({
        bookmarkId: bookmarkUserShares.bookmarkId,
        ownerUserId: bookmarks.userId,
      })
      .from(bookmarkUserShares)
      .innerJoin(bookmarks, eq(bookmarkUserShares.bookmarkId, bookmarks.id))
      .where(
        and(
          eq(bookmarkUserShares.workspaceId, workspaceId),
          eq(bookmarkUserShares.userId, viewerUserId),
          inArray(bookmarkUserShares.bookmarkId, bookmarkIds),
        ),
      );

    const teamBookmarkRows = await this.db
      .select({
        bookmarkId: bookmarkTeamShares.bookmarkId,
        ownerUserId: bookmarks.userId,
        teamName: teams.name,
      })
      .from(bookmarkTeamShares)
      .innerJoin(bookmarks, eq(bookmarkTeamShares.bookmarkId, bookmarks.id))
      .innerJoin(teams, eq(bookmarkTeamShares.teamId, teams.id))
      .innerJoin(
        teamMemberships,
        and(
          eq(teamMemberships.workspaceId, workspaceId),
          eq(teamMemberships.teamId, bookmarkTeamShares.teamId),
          eq(teamMemberships.userId, viewerUserId),
        ),
      )
      .where(
        and(
          eq(bookmarkTeamShares.workspaceId, workspaceId),
          inArray(bookmarkTeamShares.bookmarkId, bookmarkIds),
        ),
      );

    const folderUserRows = await this.db
      .select({
        bookmarkId: bookmarkFolders.bookmarkId,
        ownerUserId: bookmarks.userId,
        folderName: folders.name,
      })
      .from(bookmarkFolders)
      .innerJoin(bookmarks, eq(bookmarkFolders.bookmarkId, bookmarks.id))
      .innerJoin(
        folders,
        and(
          eq(bookmarkFolders.folderId, folders.id),
          eq(bookmarkFolders.workspaceId, workspaceId),
        ),
      )
      .innerJoin(
        folderUserShares,
        and(
          eq(folderUserShares.folderId, folders.id),
          eq(folderUserShares.workspaceId, workspaceId),
          eq(folderUserShares.userId, viewerUserId),
        ),
      )
      .where(
        and(
          eq(bookmarkFolders.workspaceId, workspaceId),
          inArray(bookmarkFolders.bookmarkId, bookmarkIds),
        ),
      );

    const folderTeamRows = await this.db
      .select({
        bookmarkId: bookmarkFolders.bookmarkId,
        ownerUserId: bookmarks.userId,
        folderName: folders.name,
      })
      .from(bookmarkFolders)
      .innerJoin(bookmarks, eq(bookmarkFolders.bookmarkId, bookmarks.id))
      .innerJoin(
        folders,
        and(
          eq(bookmarkFolders.folderId, folders.id),
          eq(bookmarkFolders.workspaceId, workspaceId),
        ),
      )
      .innerJoin(
        folderTeamShares,
        and(
          eq(folderTeamShares.folderId, folders.id),
          eq(folderTeamShares.workspaceId, workspaceId),
        ),
      )
      .innerJoin(
        teamMemberships,
        and(
          eq(teamMemberships.workspaceId, workspaceId),
          eq(teamMemberships.teamId, folderTeamShares.teamId),
          eq(teamMemberships.userId, viewerUserId),
        ),
      )
      .where(
        and(
          eq(bookmarkFolders.workspaceId, workspaceId),
          inArray(bookmarkFolders.bookmarkId, bookmarkIds),
        ),
      );

    const candidates: AccessPathCandidate[] = [];

    for (const row of directUserRows) {
      candidates.push({
        bookmarkId: row.bookmarkId,
        priority: 1,
        accessPath: {
          kind: "direct",
          ownerName: ownerNameByUserId.get(row.ownerUserId) ?? row.ownerUserId,
        },
      });
    }

    for (const row of teamBookmarkRows) {
      candidates.push({
        bookmarkId: row.bookmarkId,
        priority: 2,
        accessPath: {
          kind: "team",
          ownerName: ownerNameByUserId.get(row.ownerUserId) ?? row.ownerUserId,
          teamName: row.teamName,
        },
      });
    }

    for (const row of folderUserRows) {
      candidates.push({
        bookmarkId: row.bookmarkId,
        priority: 3,
        accessPath: {
          kind: "folder",
          ownerName: ownerNameByUserId.get(row.ownerUserId) ?? row.ownerUserId,
          folderName: row.folderName,
        },
      });
    }

    for (const row of folderTeamRows) {
      candidates.push({
        bookmarkId: row.bookmarkId,
        priority: 3,
        accessPath: {
          kind: "folder",
          ownerName: ownerNameByUserId.get(row.ownerUserId) ?? row.ownerUserId,
          folderName: row.folderName,
        },
      });
    }

    return candidates;
  }

  private async fetchOwnerNames(userIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length === 0) return new Map();

    const rows = await this.db
      .select({ id: userAccounts.id, name: userAccounts.name })
      .from(userAccounts)
      .where(inArray(userAccounts.id, uniqueIds));

    return new Map(rows.map((row) => [row.id, row.name]));
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
