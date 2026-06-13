import { coerceCount } from "../db/coerce-count.js";
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, ilike, sql, type SQL } from "drizzle-orm";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import {
  teamMemberships,
  teams,
} from "../db/schema/index.js";
import {
  WorkspaceScopedRepository,
  type WorkspaceOwned,
} from "../db/workspace-scoped.repository.js";
import type {
  CreateTeamData,
  PaginatedTeams,
  ParsedListTeamsQuery,
  TeamRecord,
  UpdateTeamData,
} from "./team.types.js";
import {
  DEFAULT_TEAM_PAGE_SIZE,
  type TeamSort,
  parsePage,
  parsePageSize,
} from "./team.validation.js";
import { SharingRepository } from "../sharing/sharing.repository.js";

type TeamRow = WorkspaceOwned & {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
};

function toDate(value: Date | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function escapeLikePattern(q: string): string {
  return q.replace(/[%_\\]/g, "\\$&");
}

function orderByForSort(
  sort: TeamSort,
  teamsTable: typeof teams,
) {
  switch (sort) {
    case "name-asc":
      return asc(teamsTable.name);
    case "name-desc":
      return desc(teamsTable.name);
    case "created-asc":
      return asc(teamsTable.createdAt);
    case "members-desc":
    case "members-asc":
    case "created-desc":
    default:
      return desc(teamsTable.createdAt);
  }
}

export class TeamRepository extends WorkspaceScopedRepository<TeamRecord> {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- forwards db to WorkspaceScopedRepository
  constructor(db: DrizzleClient) {
    super(db);
  }

  async create(
    workspaceId: string,
    data: CreateTeamData,
  ): Promise<TeamRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

        const rows = await this.db
      .insert(teams)
      .values({
        id,
        workspaceId,
        name: data.name,
        description: data.description ?? null,
        createdAt: nowMs,
        updatedAt: nowMs,
      })
      .returning();
    const row = rows[0];
    const team = this.assertOwnership(
      workspaceId,
      row ? await this.toTeamRecord(row) : null,
    );
    if (data.memberIds?.length) {
      await this.replaceTeamMembers(workspaceId, id, data.memberIds);
      const withMembers = await this.findById(workspaceId, id);
      if (!withMembers) throw new Error("Failed to load team after member links");
      return withMembers;
    }
    return team;
  }

  async findById(
    workspaceId: string,
    teamId: string,
  ): Promise<TeamRecord | null> {

    const rows = await this.db
      .select()
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ? await this.toTeamRecord(rows[0]) : null;
  }

  async list(
    workspaceId: string,
    query: ParsedListTeamsQuery,
  ): Promise<PaginatedTeams> {
    const sort = query.sort;
    const page = parsePage(query.page);
    const pageSize = parsePageSize(query.pageSize ?? DEFAULT_TEAM_PAGE_SIZE);
    const offset = (page - 1) * pageSize;
    const searchPattern =
      query.q && query.q.trim().length > 0
        ? `%${escapeLikePattern(query.q.trim())}%`
        : null;

        const conditions: SQL[] = [eq(teams.workspaceId, workspaceId)];
    if (searchPattern) {
      conditions.push(ilike(teams.name, searchPattern));
    }
    const whereClause = and(...conditions);

    const countRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(teams)
      .where(whereClause);
    const total = coerceCount(countRows[0]?.count);

    const rows = await this.db
      .select()
      .from(teams)
      .where(whereClause)
      .orderBy(orderByForSort(sort, teams))
      .limit(pageSize)
      .offset(offset);

    let items = await Promise.all(rows.map((row) => this.toTeamRecord(row)));

    if (sort === "members-desc" || sort === "members-asc") {
      items = items.sort((a, b) =>
        sort === "members-desc"
          ? b.memberCount - a.memberCount
          : a.memberCount - b.memberCount,
      );
    }

    return {
      items: this.assertAllOwned(workspaceId, items),
      total,
      page,
      pageSize,
    };
  }

  async update(
    workspaceId: string,
    teamId: string,
    patch: UpdateTeamData,
  ): Promise<TeamRecord | null> {
    const nowMs = Date.now();
    const updates: Record<string, unknown> = { updatedAt: nowMs };

    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.description !== undefined) updates.description = patch.description;

    await this.db
      .update(teams)
      .set(updates)
      .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)));

    return this.findById(workspaceId, teamId);
  }

  async delete(workspaceId: string, teamId: string): Promise<void> {
    const sharingRepo = new SharingRepository(this.db);
    await sharingRepo.deleteSharesForTeam(workspaceId, teamId);
    await this.deleteMembershipsForTeam(workspaceId, teamId);

    await this.db
      .delete(teams)
      .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)));
  }

  async replaceTeamMembers(
    workspaceId: string,
    teamId: string,
    userIds: string[],
  ): Promise<void> {
    await this.deleteMembershipsForTeam(workspaceId, teamId);

    const uniqueIds = [...new Set(userIds)];
    for (const userId of uniqueIds) {
      await this.insertTeamMembership(workspaceId, teamId, userId);
    }
  }

  async addTeamMember(
    workspaceId: string,
    teamId: string,
    userId: string,
  ): Promise<void> {
    await this.insertTeamMembership(workspaceId, teamId, userId);
  }

  async removeTeamMember(
    workspaceId: string,
    teamId: string,
    userId: string,
  ): Promise<void> {

    await this.db
      .delete(teamMemberships)
      .where(
        and(
          eq(teamMemberships.workspaceId, workspaceId),
          eq(teamMemberships.teamId, teamId),
          eq(teamMemberships.userId, userId),
        ),
      );
  }

  async listMemberIdsForTeam(
    workspaceId: string,
    teamId: string,
  ): Promise<string[]> {

    const rows = await this.db
      .select({ userId: teamMemberships.userId })
      .from(teamMemberships)
      .where(
        and(
          eq(teamMemberships.workspaceId, workspaceId),
          eq(teamMemberships.teamId, teamId),
        ),
      );
    return rows.map((r) => r.userId);
  }

  private async deleteMembershipsForTeam(
    workspaceId: string,
    teamId: string,
  ): Promise<void> {

    await this.db
      .delete(teamMemberships)
      .where(
        and(
          eq(teamMemberships.workspaceId, workspaceId),
          eq(teamMemberships.teamId, teamId),
        ),
      );
  }

  private async insertTeamMembership(
    workspaceId: string,
    teamId: string,
    userId: string,
  ): Promise<void> {
    const id = randomUUID();
    const nowMs = Date.now();

    await this.db.insert(teamMemberships).values({
      id,
      workspaceId,
      teamId,
      userId,
      createdAt: nowMs,
    });
  }

  private async countMembersInTeam(
    workspaceId: string,
    teamId: string,
  ): Promise<number> {

    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(teamMemberships)
      .where(
        and(
          eq(teamMemberships.workspaceId, workspaceId),
          eq(teamMemberships.teamId, teamId),
        ),
      );
    return coerceCount(rows[0]?.count);
  }

  private async toTeamRecord(row: TeamRow): Promise<TeamRecord> {
    const memberIds = await this.listMemberIdsForTeam(row.workspaceId, row.id);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      description: row.description,
      memberCount: memberIds.length,
      memberIds,
      createdAt: toDate(row.createdAt),
      updatedAt: toDate(row.updatedAt),
    };
  }
}
