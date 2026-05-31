import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, like, sql, type SQL } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import {
  teamMemberships as sqliteTeamMemberships,
  teams as sqliteTeams,
} from "../db/schema/index.js";
import {
  teamMemberships as pgTeamMemberships,
  teams as pgTeams,
} from "../db/schema/pg-index.js";
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
  teamsTable: typeof sqliteTeams | typeof pgTeams,
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
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- forwards db + dialect
  constructor(db: DrizzleClient, dialect: DbDialect) {
    super(db, dialect);
  }

  async create(
    workspaceId: string,
    data: CreateTeamData,
  ): Promise<TeamRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteTeams)
        .values({
          id,
          workspaceId,
          name: data.name,
          description: data.description ?? null,
          createdAt: new Date(nowMs),
          updatedAt: new Date(nowMs),
        })
        .run();

      const row = sqliteDb
        .select()
        .from(sqliteTeams)
        .where(
          and(eq(sqliteTeams.id, id), eq(sqliteTeams.workspaceId, workspaceId)),
        )
        .get();
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

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .insert(pgTeams)
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
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteTeams)
        .where(
          and(eq(sqliteTeams.id, teamId), eq(sqliteTeams.workspaceId, workspaceId)),
        )
        .get();
      return row ? await this.toTeamRecord(row) : null;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgTeams)
      .where(and(eq(pgTeams.id, teamId), eq(pgTeams.workspaceId, workspaceId)))
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

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const conditions: SQL[] = [eq(sqliteTeams.workspaceId, workspaceId)];
      if (searchPattern) {
        conditions.push(like(sqliteTeams.name, searchPattern));
      }
      const whereClause = and(...conditions);

      const countRow = sqliteDb
        .select({ count: sql<number>`count(*)` })
        .from(sqliteTeams)
        .where(whereClause)
        .get();
      const total = countRow?.count ?? 0;

      const rows = sqliteDb
        .select()
        .from(sqliteTeams)
        .where(whereClause)
        .orderBy(orderByForSort(sort, sqliteTeams))
        .limit(pageSize)
        .offset(offset)
        .all();

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

    const pgDb = this.db as PostgresDrizzleClient;
    const conditions: SQL[] = [eq(pgTeams.workspaceId, workspaceId)];
    if (searchPattern) {
      conditions.push(like(pgTeams.name, searchPattern));
    }
    const whereClause = and(...conditions);

    const countRows = await pgDb
      .select({ count: sql<number>`count(*)` })
      .from(pgTeams)
      .where(whereClause);
    const total = countRows[0]?.count ?? 0;

    const rows = await pgDb
      .select()
      .from(pgTeams)
      .where(whereClause)
      .orderBy(orderByForSort(sort, pgTeams))
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

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .update(sqliteTeams)
        .set({
          ...updates,
          updatedAt: new Date(nowMs),
        })
        .where(
          and(eq(sqliteTeams.id, teamId), eq(sqliteTeams.workspaceId, workspaceId)),
        )
        .run();
      return this.findById(workspaceId, teamId);
    }

    await (this.db as PostgresDrizzleClient)
      .update(pgTeams)
      .set(updates)
      .where(and(eq(pgTeams.id, teamId), eq(pgTeams.workspaceId, workspaceId)));

    return this.findById(workspaceId, teamId);
  }

  async delete(workspaceId: string, teamId: string): Promise<void> {
    const sharingRepo = new SharingRepository(this.db, this.dialect);
    await sharingRepo.deleteSharesForTeam(workspaceId, teamId);
    await this.deleteMembershipsForTeam(workspaceId, teamId);

    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteTeams)
        .where(
          and(eq(sqliteTeams.id, teamId), eq(sqliteTeams.workspaceId, workspaceId)),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .delete(pgTeams)
      .where(and(eq(pgTeams.id, teamId), eq(pgTeams.workspaceId, workspaceId)));
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
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteTeamMemberships)
        .where(
          and(
            eq(sqliteTeamMemberships.workspaceId, workspaceId),
            eq(sqliteTeamMemberships.teamId, teamId),
            eq(sqliteTeamMemberships.userId, userId),
          ),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .delete(pgTeamMemberships)
      .where(
        and(
          eq(pgTeamMemberships.workspaceId, workspaceId),
          eq(pgTeamMemberships.teamId, teamId),
          eq(pgTeamMemberships.userId, userId),
        ),
      );
  }

  async listMemberIdsForTeam(
    workspaceId: string,
    teamId: string,
  ): Promise<string[]> {
    if (this.dialect === "sqlite") {
      const rows = (this.db as SqliteDrizzleClient)
        .select({ userId: sqliteTeamMemberships.userId })
        .from(sqliteTeamMemberships)
        .where(
          and(
            eq(sqliteTeamMemberships.workspaceId, workspaceId),
            eq(sqliteTeamMemberships.teamId, teamId),
          ),
        )
        .all();
      return rows.map((r) => r.userId);
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select({ userId: pgTeamMemberships.userId })
      .from(pgTeamMemberships)
      .where(
        and(
          eq(pgTeamMemberships.workspaceId, workspaceId),
          eq(pgTeamMemberships.teamId, teamId),
        ),
      );
    return rows.map((r) => r.userId);
  }

  private async deleteMembershipsForTeam(
    workspaceId: string,
    teamId: string,
  ): Promise<void> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteTeamMemberships)
        .where(
          and(
            eq(sqliteTeamMemberships.workspaceId, workspaceId),
            eq(sqliteTeamMemberships.teamId, teamId),
          ),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .delete(pgTeamMemberships)
      .where(
        and(
          eq(pgTeamMemberships.workspaceId, workspaceId),
          eq(pgTeamMemberships.teamId, teamId),
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

    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .insert(sqliteTeamMemberships)
        .values({
          id,
          workspaceId,
          teamId,
          userId,
          createdAt: new Date(nowMs),
        })
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient).insert(pgTeamMemberships).values({
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
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select({ count: sql<number>`count(*)` })
        .from(sqliteTeamMemberships)
        .where(
          and(
            eq(sqliteTeamMemberships.workspaceId, workspaceId),
            eq(sqliteTeamMemberships.teamId, teamId),
          ),
        )
        .get();
      return row?.count ?? 0;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select({ count: sql<number>`count(*)` })
      .from(pgTeamMemberships)
      .where(
        and(
          eq(pgTeamMemberships.workspaceId, workspaceId),
          eq(pgTeamMemberships.teamId, teamId),
        ),
      );
    return rows[0]?.count ?? 0;
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
