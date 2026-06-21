import { count, eq } from "drizzle-orm";

import type { PublicReadDb } from "./create-public-read-db.js";
import { workspaceMembers } from "./workspace-member.schema.js";
import { workspaces } from "./workspace.schema.js";

export type BillingSummary = {
  stripeDashboardUrl: string;
  workspacesByPlan: Array<{ plan: string; count: number }>;
  workspacesByBillingStatus: Array<{ billingStatus: string | null; count: number }>;
  teamSeatUtilization: Array<{
    workspaceId: string;
    workspaceName: string;
    planSeats: number | null;
    memberCount: number;
    utilization: number | null;
  }>;
};

const STRIPE_DASHBOARD_URL = "https://dashboard.stripe.com/";

function readCount(value: number | string | bigint | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value);
}

export async function fetchBillingSummary(
  publicReadDb: PublicReadDb,
): Promise<BillingSummary> {
  const { db } = publicReadDb;

  const [planRows, billingStatusRows, teamWorkspaces] = await Promise.all([
    db
      .select({
        plan: workspaces.plan,
        count: count(),
      })
      .from(workspaces)
      .groupBy(workspaces.plan),
    db
      .select({
        billingStatus: workspaces.billingStatus,
        count: count(),
      })
      .from(workspaces)
      .groupBy(workspaces.billingStatus),
    db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        planSeats: workspaces.planSeats,
      })
      .from(workspaces)
      .where(eq(workspaces.plan, "team")),
  ]);

  const teamSeatUtilization = await Promise.all(
    teamWorkspaces.map(async (workspace) => {
      const [memberCountRow] = await db
        .select({ value: count() })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspace.id));

      const memberCount = readCount(memberCountRow?.value);
      const planSeats = workspace.planSeats;
      const utilization =
        planSeats !== null && planSeats > 0
          ? Math.round((memberCount / planSeats) * 100)
          : null;

      return {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        planSeats,
        memberCount,
        utilization,
      };
    }),
  );

  return {
    stripeDashboardUrl: STRIPE_DASHBOARD_URL,
    workspacesByPlan: planRows.map((row) => ({
      plan: row.plan,
      count: readCount(row.count),
    })),
    workspacesByBillingStatus: billingStatusRows.map((row) => ({
      billingStatus: row.billingStatus,
      count: readCount(row.count),
    })),
    teamSeatUtilization,
  };
}
