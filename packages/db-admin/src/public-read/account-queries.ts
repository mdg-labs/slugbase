import {
  asc,
  count,
  desc,
  eq,
  sql,
  type SQL,
} from "drizzle-orm";

import type { PublicReadDb } from "./create-public-read-db.js";
import { parsePagination, type ParsedPagination } from "./pagination.js";
import { userAccounts } from "./user-account.schema.js";
import { workspaceMembers } from "./workspace-member.schema.js";
import { workspaces } from "./workspace.schema.js";

export const ACCOUNT_SORT_FIELDS = [
  "email",
  "name",
  "created_at",
  "verified",
  "mfa_state",
  "workspace_count",
] as const;

export type AccountSortField = (typeof ACCOUNT_SORT_FIELDS)[number];
export type SortOrder = "asc" | "desc";

export type AccountListItem = {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  emailVerified: boolean;
  mfaState: string;
  language: string;
  aiOptOut: boolean;
  workspaceCount: number;
};

export type AccountMembership = {
  workspaceId: string;
  workspaceName: string;
  role: string;
};

export type AccountDetail = AccountListItem & {
  memberships: AccountMembership[];
};

export type PaginatedAccounts = {
  items: AccountListItem[];
  pagination: ParsedPagination & { total: number };
};

function readCount(value: number | string | bigint | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value);
}

function resolveAccountOrderBy(
  sort: AccountSortField,
  order: SortOrder,
): SQL {
  const direction = order === "asc" ? asc : desc;

  switch (sort) {
    case "email":
      return direction(userAccounts.email);
    case "name":
      return direction(userAccounts.name);
    case "created_at":
      return direction(userAccounts.createdAt);
    case "verified":
      return direction(userAccounts.emailVerified);
    case "mfa_state":
      return direction(userAccounts.mfaState);
    case "workspace_count":
      return direction(sql`workspace_count`);
    default: {
      const exhaustive: never = sort;
      return exhaustive;
    }
  }
}

export async function fetchAccountsPage(
  publicReadDb: PublicReadDb,
  options: {
    page?: number;
    limit?: number;
    sort?: AccountSortField;
    order?: SortOrder;
  } = {},
): Promise<PaginatedAccounts> {
  const pagination = parsePagination(options.page, options.limit);
  const sort = options.sort ?? "created_at";
  const order = options.order ?? "desc";
  const { db } = publicReadDb;

  const workspaceCountSubquery = db
    .select({
      userId: workspaceMembers.userId,
      workspaceCount: count().as("workspace_count"),
    })
    .from(workspaceMembers)
    .groupBy(workspaceMembers.userId)
    .as("workspace_counts");

  const [totalRow, rows] = await Promise.all([
    db.select({ value: count() }).from(userAccounts),
    db
      .select({
        id: userAccounts.id,
        email: userAccounts.email,
        name: userAccounts.name,
        createdAt: userAccounts.createdAt,
        emailVerified: userAccounts.emailVerified,
        mfaState: userAccounts.mfaState,
        language: userAccounts.language,
        aiOptOut: userAccounts.aiOptOut,
        workspaceCount: sql<number>`coalesce(${workspaceCountSubquery.workspaceCount}, 0)`
          .mapWith(Number),
      })
      .from(userAccounts)
      .leftJoin(
        workspaceCountSubquery,
        eq(userAccounts.id, workspaceCountSubquery.userId),
      )
      .orderBy(resolveAccountOrderBy(sort, order))
      .limit(pagination.limit)
      .offset(pagination.offset),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      createdAt: row.createdAt,
      emailVerified: row.emailVerified,
      mfaState: row.mfaState,
      language: row.language,
      aiOptOut: row.aiOptOut,
      workspaceCount: readCount(row.workspaceCount),
    })),
    pagination: {
      ...pagination,
      total: readCount(totalRow[0]?.value),
    },
  };
}

export async function fetchAccountById(
  publicReadDb: PublicReadDb,
  accountId: string,
): Promise<AccountDetail | null> {
  const { db } = publicReadDb;

  const workspaceCountSubquery = db
    .select({
      userId: workspaceMembers.userId,
      workspaceCount: count().as("workspace_count"),
    })
    .from(workspaceMembers)
    .groupBy(workspaceMembers.userId)
    .as("workspace_counts");

  const [accountRow] = await db
    .select({
      id: userAccounts.id,
      email: userAccounts.email,
      name: userAccounts.name,
      createdAt: userAccounts.createdAt,
      emailVerified: userAccounts.emailVerified,
      mfaState: userAccounts.mfaState,
      language: userAccounts.language,
      aiOptOut: userAccounts.aiOptOut,
      workspaceCount: sql<number>`coalesce(${workspaceCountSubquery.workspaceCount}, 0)`
        .mapWith(Number),
    })
    .from(userAccounts)
    .leftJoin(
      workspaceCountSubquery,
      eq(userAccounts.id, workspaceCountSubquery.userId),
    )
    .where(eq(userAccounts.id, accountId))
    .limit(1);

  if (!accountRow) {
    return null;
  }

  const membershipRows = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      workspaceName: workspaces.name,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, accountId));

  return {
    id: accountRow.id,
    email: accountRow.email,
    name: accountRow.name,
    createdAt: accountRow.createdAt,
    emailVerified: accountRow.emailVerified,
    mfaState: accountRow.mfaState,
    language: accountRow.language,
    aiOptOut: accountRow.aiOptOut,
    workspaceCount: readCount(accountRow.workspaceCount),
    memberships: membershipRows.map((row) => ({
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      role: row.role,
    })),
  };
}
