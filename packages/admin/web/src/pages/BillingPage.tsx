import { getBillingSummary } from "../api/client.js";
import { DataTable, type DataTableColumn } from "../components/DataTable.js";
import { ErrorRetry } from "../components/Feedback.js";
import { PageHeader } from "../components/PageHeader.js";
import { StatCard, StatGrid } from "../components/StatCard.js";
import { useAsyncData } from "../hooks/useAsyncData.js";

type PlanRow = { plan: string; count: number };
type StatusRow = { billingStatus: string | null; count: number };
type SeatRow = {
  workspaceId: string;
  workspaceName: string;
  planSeats: number | null;
  memberCount: number;
  utilization: number | null;
};

const planColumns: DataTableColumn<PlanRow>[] = [
  { key: "plan", header: "Plan", mono: true, render: (row) => row.plan },
  { key: "count", header: "Workspaces", render: (row) => row.count },
];

const statusColumns: DataTableColumn<StatusRow>[] = [
  {
    key: "status",
    header: "Billing status",
    render: (row) => row.billingStatus ?? "—",
  },
  { key: "count", header: "Workspaces", render: (row) => row.count },
];

const seatColumns: DataTableColumn<SeatRow>[] = [
  {
    key: "workspace",
    header: "Team workspace",
    render: (row) => row.workspaceName,
  },
  { key: "members", header: "Members", render: (row) => row.memberCount },
  {
    key: "seats",
    header: "Seats",
    render: (row) => row.planSeats ?? "—",
  },
  {
    key: "util",
    header: "Utilization",
    render: (row) =>
      row.utilization === null ? "—" : `${String(row.utilization)}%`,
  },
];

export function BillingPage() {
  const { data, loading, error, reload } = useAsyncData(
    () => getBillingSummary(),
    [],
  );

  if (error !== null) {
    return (
      <>
        <PageHeader title="Billing" subtitle="Read-only plan and status breakdown" />
        <ErrorRetry message={error} onRetry={reload} />
      </>
    );
  }

  const totalWorkspaces =
    data?.workspacesByPlan.reduce((sum, row) => sum + row.count, 0) ?? 0;

  return (
    <>
      <PageHeader
        title="Billing"
        subtitle="Read-only plan and status breakdown"
        actions={
          data ? (
            <a
              href={data.stripeDashboardUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                fontSize: "var(--text-sm)",
                padding: "var(--sp-2) var(--sp-3)",
                background: "var(--raised)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-sm)",
                textDecoration: "none",
                color: "var(--fg)",
              }}
            >
              Open Stripe Dashboard ↗
            </a>
          ) : null
        }
      />
      <StatGrid>
        <StatCard label="Workspaces" value={loading ? "—" : totalWorkspaces} />
        <StatCard
          label="Team workspaces"
          value={loading ? "—" : (data?.teamSeatUtilization.length ?? 0)}
        />
      </StatGrid>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "var(--sp-4)",
        }}
      >
        <div>
          <h3 style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)" }}>
            By plan
          </h3>
          <DataTable
            columns={planColumns}
            rows={data?.workspacesByPlan ?? []}
            rowKey={(row) => row.plan}
            loading={loading}
            emptyTitle="No billing data"
          />
        </div>
        <div>
          <h3 style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)" }}>
            By billing status
          </h3>
          <DataTable
            columns={statusColumns}
            rows={data?.workspacesByBillingStatus ?? []}
            rowKey={(row) => row.billingStatus ?? "none"}
            loading={loading}
            emptyTitle="No status data"
          />
        </div>
      </div>
      <h3
        style={{
          marginTop: "var(--sp-6)",
          fontSize: "var(--text-sm)",
          color: "var(--fg-muted)",
        }}
      >
        Team seat utilization
      </h3>
      <DataTable
        columns={seatColumns}
        rows={data?.teamSeatUtilization ?? []}
        rowKey={(row) => row.workspaceId}
        loading={loading}
        emptyTitle="No team workspaces"
        emptyDescription="Seat utilization appears for workspaces on the Team plan."
      />
    </>
  );
}
