import {
  count,
  desc,
  eq,
  sql,
} from "drizzle-orm";

import { bookmarks } from "./bookmark.schema.js";
import type { PublicReadDb } from "./create-public-read-db.js";
import { FREE_BOOKMARK_CAP } from "./constants.js";
import { parsePagination, type ParsedPagination } from "./pagination.js";
import { userAccounts } from "./user-account.schema.js";
import { workspaceMembers } from "./workspace-member.schema.js";
import { workspaces } from "./workspace.schema.js";

export type WorkspaceListItem = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  planSeats: number | null;
  planArchived: boolean;
  billingStatus: string | null;
  billingPeriodEnd: number | null;
  permanentPersonal: boolean;
  createdAt: number;
  memberCount: number;
  activeBookmarkCount: number;
  archivedBookmarkCount: number;
};

export type WorkspaceMemberDetail = {
  userId: string;
  email: string;
  role: string;
};

export type WorkspaceDetail = WorkspaceListItem & {
  members: WorkspaceMemberDetail[];
  freeBookmarkCap: number | null;
  bookmarkUsage: {
    active: number;
    archived: number;
    cap: number | null;
  };
};

export type PaginatedWorkspaces = {
  items: WorkspaceListItem[];
  pagination: ParsedPagination & { total: number };
};

function readCount(value: number | string | bigint | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value);
}

export async function fetchWorkspacesPage(
  publicReadDb: PublicReadDb,
  options: {
    page?: number;
    limit?: number;
  } = {},
): Promise<PaginatedWorkspaces> {
  const pagination = parsePagination(options.page, options.limit);
  const { db } = publicReadDb;

  const memberCountSubquery = db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      memberCount: count().as("member_count"),
    })
    .from(workspaceMembers)
    .groupBy(workspaceMembers.workspaceId)
    .as("member_counts");

  const activeBookmarkSubquery = db
    .select({
      workspaceId: bookmarks.workspaceId,
      activeBookmarkCount: count().as("active_bookmark_count"),
    })
    .from(bookmarks)
    .where(eq(bookmarks.planArchived, false))
    .groupBy(bookmarks.workspaceId)
    .as("active_bookmark_counts");

  const archivedBookmarkSubquery = db
    .select({
      workspaceId: bookmarks.workspaceId,
      archivedBookmarkCount: count().as("archived_bookmark_count"),
    })
    .from(bookmarks)
    .where(eq(bookmarks.planArchived, true))
    .groupBy(bookmarks.workspaceId)
    .as("archived_bookmark_counts");

  const [totalRow, rows] = await Promise.all([
    db.select({ value: count() }).from(workspaces),
    db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        plan: workspaces.plan,
        planSeats: workspaces.planSeats,
        planArchived: workspaces.planArchived,
        billingStatus: workspaces.billingStatus,
        billingPeriodEnd: workspaces.billingPeriodEnd,
        permanentPersonal: workspaces.permanentPersonal,
        createdAt: workspaces.createdAt,
        memberCount: sql<number>`coalesce(${memberCountSubquery.memberCount}, 0)`
          .mapWith(Number),
        activeBookmarkCount: sql<number>`coalesce(${activeBookmarkSubquery.activeBookmarkCount}, 0)`
          .mapWith(Number),
        archivedBookmarkCount: sql<number>`coalesce(${archivedBookmarkSubquery.archivedBookmarkCount}, 0)`
          .mapWith(Number),
      })
      .from(workspaces)
      .leftJoin(
        memberCountSubquery,
        eq(workspaces.id, memberCountSubquery.workspaceId),
      )
      .leftJoin(
        activeBookmarkSubquery,
        eq(workspaces.id, activeBookmarkSubquery.workspaceId),
      )
      .leftJoin(
        archivedBookmarkSubquery,
        eq(workspaces.id, archivedBookmarkSubquery.workspaceId),
      )
      .orderBy(desc(workspaces.createdAt))
      .limit(pagination.limit)
      .offset(pagination.offset),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      plan: row.plan,
      planSeats: row.planSeats,
      planArchived: row.planArchived,
      billingStatus: row.billingStatus,
      billingPeriodEnd: row.billingPeriodEnd,
      permanentPersonal: row.permanentPersonal,
      createdAt: row.createdAt,
      memberCount: readCount(row.memberCount),
      activeBookmarkCount: readCount(row.activeBookmarkCount),
      archivedBookmarkCount: readCount(row.archivedBookmarkCount),
    })),
    pagination: {
      ...pagination,
      total: readCount(totalRow[0]?.value),
    },
  };
}

async function fetchWorkspaceSummary(
  publicReadDb: PublicReadDb,
  workspaceId: string,
): Promise<WorkspaceListItem | null> {
  const { db } = publicReadDb;

  const memberCountSubquery = db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      memberCount: count().as("member_count"),
    })
    .from(workspaceMembers)
    .groupBy(workspaceMembers.workspaceId)
    .as("member_counts");

  const activeBookmarkSubquery = db
    .select({
      workspaceId: bookmarks.workspaceId,
      activeBookmarkCount: count().as("active_bookmark_count"),
    })
    .from(bookmarks)
    .where(eq(bookmarks.planArchived, false))
    .groupBy(bookmarks.workspaceId)
    .as("active_bookmark_counts");

  const archivedBookmarkSubquery = db
    .select({
      workspaceId: bookmarks.workspaceId,
      archivedBookmarkCount: count().as("archived_bookmark_count"),
    })
    .from(bookmarks)
    .where(eq(bookmarks.planArchived, true))
    .groupBy(bookmarks.workspaceId)
    .as("archived_bookmark_counts");

  const [row] = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      plan: workspaces.plan,
      planSeats: workspaces.planSeats,
      planArchived: workspaces.planArchived,
      billingStatus: workspaces.billingStatus,
      billingPeriodEnd: workspaces.billingPeriodEnd,
      permanentPersonal: workspaces.permanentPersonal,
      createdAt: workspaces.createdAt,
      memberCount: sql<number>`coalesce(${memberCountSubquery.memberCount}, 0)`
        .mapWith(Number),
      activeBookmarkCount: sql<number>`coalesce(${activeBookmarkSubquery.activeBookmarkCount}, 0)`
        .mapWith(Number),
      archivedBookmarkCount: sql<number>`coalesce(${archivedBookmarkSubquery.archivedBookmarkCount}, 0)`
        .mapWith(Number),
    })
    .from(workspaces)
    .leftJoin(
      memberCountSubquery,
      eq(workspaces.id, memberCountSubquery.workspaceId),
    )
    .leftJoin(
      activeBookmarkSubquery,
      eq(workspaces.id, activeBookmarkSubquery.workspaceId),
    )
    .leftJoin(
      archivedBookmarkSubquery,
      eq(workspaces.id, archivedBookmarkSubquery.workspaceId),
    )
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    planSeats: row.planSeats,
    planArchived: row.planArchived,
    billingStatus: row.billingStatus,
    billingPeriodEnd: row.billingPeriodEnd,
    permanentPersonal: row.permanentPersonal,
    createdAt: row.createdAt,
    memberCount: readCount(row.memberCount),
    activeBookmarkCount: readCount(row.activeBookmarkCount),
    archivedBookmarkCount: readCount(row.archivedBookmarkCount),
  };
}

export async function fetchWorkspaceById(
  publicReadDb: PublicReadDb,
  workspaceId: string,
): Promise<WorkspaceDetail | null> {
  const summary = await fetchWorkspaceSummary(publicReadDb, workspaceId);
  if (!summary) {
    return null;
  }

  const { db } = publicReadDb;
  const memberRows = await db
    .select({
      userId: workspaceMembers.userId,
      email: userAccounts.email,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(userAccounts, eq(workspaceMembers.userId, userAccounts.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId));

  const isFreePlan = summary.plan === "free" && !summary.permanentPersonal;

  return {
    ...summary,
    members: memberRows.map((row) => ({
      userId: row.userId,
      email: row.email,
      role: row.role,
    })),
    freeBookmarkCap: isFreePlan ? FREE_BOOKMARK_CAP : null,
    bookmarkUsage: {
      active: summary.activeBookmarkCount,
      archived: summary.archivedBookmarkCount,
      cap: isFreePlan ? FREE_BOOKMARK_CAP : null,
    },
  };
}
