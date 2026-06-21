import type { LiveOverviewStats } from "../stats/product-read.service.js";
import type { MetricsHistoryItem } from "../stats/metrics-history.service.js";

function escapeCsvValue(value: string | number | boolean | null): string {
  if (value === null) {
    return "";
  }

  const stringValue = String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }

  return stringValue;
}

function toCsvRow(values: Array<string | number | boolean | null>): string {
  return values.map(escapeCsvValue).join(",");
}

/** Aggregate-only overview export (admin PRD §9.5). */
export function overviewStatsToCsv(stats: LiveOverviewStats): string {
  const rows: string[] = [
    toCsvRow(["metric", "value"]),
    toCsvRow(["computed_at", stats.computedAt]),
    toCsvRow(["free_bookmark_cap", stats.freeBookmarkCap]),
    toCsvRow(["total_accounts", stats.totalAccounts]),
    toCsvRow(["total_workspaces", stats.totalWorkspaces]),
    toCsvRow(["signups_last_7_days", stats.signupsLast7Days]),
    toCsvRow(["signups_last_30_days", stats.signupsLast30Days]),
    toCsvRow(["active_bookmarks", stats.activeBookmarks]),
    toCsvRow(["plan_archived_bookmarks", stats.planArchivedBookmarks]),
    toCsvRow(["mfa_enrolled", stats.mfaAdoption.enrolled]),
    toCsvRow(["mfa_total", stats.mfaAdoption.total]),
    toCsvRow(["email_verified", stats.emailVerification.verified]),
    toCsvRow(["email_total", stats.emailVerification.total]),
    toCsvRow(["active_sessions", stats.activeSessions]),
    toCsvRow(["pending_invitations", stats.pendingInvitations]),
    toCsvRow(["processed_webhook_events_total", stats.processedWebhookEvents.total]),
    toCsvRow(["paid_vs_free_free_workspaces", stats.paidVsFree.freeWorkspaces]),
    toCsvRow(["paid_vs_free_paid_workspaces", stats.paidVsFree.paidWorkspaces]),
  ];

  for (const entry of stats.planDistribution) {
    rows.push(toCsvRow([`plan_${entry.plan}`, entry.count]));
  }

  for (const entry of stats.paidVsFree.byBillingStatus) {
    const label = entry.billingStatus ?? "none";
    rows.push(toCsvRow([`billing_status_${label}`, entry.count]));
  }

  for (const entry of stats.processedWebhookEvents.byEventType) {
    rows.push(toCsvRow([`webhook_event_${entry.eventType}`, entry.count]));
  }

  return `${rows.join("\n")}\n`;
}

/** Aggregate-only history export (admin PRD §9.5). */
export function metricsHistoryToCsv(items: MetricsHistoryItem[]): string {
  const header = toCsvRow([
    "snapshot_date",
    "total_accounts",
    "new_accounts",
    "verified_accounts",
    "mfa_enrolled_accounts",
    "total_workspaces",
    "new_workspaces",
    "workspaces_free",
    "workspaces_personal",
    "workspaces_team",
    "total_bookmarks",
    "plan_archived_bookmarks",
    "total_memberships",
    "active_subscriptions",
    "processed_webhook_events",
    "computed_at",
  ]);

  const rows = items.map((item) =>
    toCsvRow([
      item.snapshotDate,
      item.totalAccounts,
      item.newAccounts,
      item.verifiedAccounts,
      item.mfaEnrolledAccounts,
      item.totalWorkspaces,
      item.newWorkspaces,
      item.workspacesByPlan.free,
      item.workspacesByPlan.personal,
      item.workspacesByPlan.team,
      item.totalBookmarks,
      item.planArchivedBookmarks,
      item.totalMemberships,
      item.activeSubscriptions,
      item.processedWebhookEvents,
      item.computedAt,
    ]),
  );

  return `${[header, ...rows].join("\n")}\n`;
}
