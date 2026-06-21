import { Link, useParams } from "react-router";

import { getWorkspace } from "../api/client.js";
import type { WorkspaceMemberDetail } from "../api/types.js";
import { BookmarkCapMeter } from "../components/BookmarkCapMeter.js";
import { DataTable, type DataTableColumn } from "../components/DataTable.js";
import { ErrorRetry } from "../components/Feedback.js";
import { PageHeader } from "../components/PageHeader.js";
import { useAsyncData } from "../hooks/useAsyncData.js";

const memberColumns: DataTableColumn<WorkspaceMemberDetail>[] = [
  {
    key: "email",
    header: "Email",
    render: (row) => row.email,
  },
  {
    key: "role",
    header: "Role",
    mono: true,
    render: (row) => row.role,
  },
];

export function WorkspaceDetailPage() {
  const { id = "" } = useParams();
  const { data, loading, error, reload } = useAsyncData(
    () => getWorkspace(id),
    [id],
  );

  if (error !== null) {
    return (
      <>
        <PageHeader title="Workspace" />
        <ErrorRetry message={error} onRetry={reload} />
      </>
    );
  }

  const isFree = data?.plan === "free";

  return (
    <>
      <PageHeader
        title={loading ? "Loading…" : (data?.name ?? "Workspace")}
        subtitle={data ? `${data.slug} · ${data.plan}` : undefined}
        actions={
          <Link to="/workspaces" style={{ fontSize: "var(--text-sm)" }}>
            ← Back to workspaces
          </Link>
        }
      />
      {data !== null ? (
        <div
          style={{
            display: "grid",
            gap: "var(--sp-4)",
            marginBottom: "var(--sp-6)",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: "var(--sp-3)",
              fontSize: "var(--text-sm)",
              color: "var(--fg-muted)",
            }}
          >
            <div>Billing: {data.billingStatus ?? "—"}</div>
            <div>Members: {data.memberCount}</div>
            <div>Seats: {data.planSeats ?? "—"}</div>
          </div>
          {isFree ? (
            <div
              style={{
                maxWidth: 360,
                padding: "var(--sp-4)",
                background: "var(--raised)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-md)",
              }}
            >
              <h3 style={{ margin: "0 0 var(--sp-2)", fontSize: "var(--text-sm)" }}>
                Free plan bookmark cap
              </h3>
              <BookmarkCapMeter
                active={data.bookmarkUsage.active}
                cap={data.bookmarkUsage.cap ?? undefined}
                archived={data.bookmarkUsage.archived}
              />
            </div>
          ) : (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)" }}>
              Active bookmarks: {data.bookmarkUsage.active}
              {data.bookmarkUsage.archived > 0
                ? ` · ${String(data.bookmarkUsage.archived)} plan-archived`
                : ""}
            </div>
          )}
        </div>
      ) : null}
      <h3 style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)" }}>Members</h3>
      <DataTable
        columns={memberColumns}
        rows={data?.members ?? []}
        rowKey={(row) => row.userId}
        loading={loading}
        emptyTitle="No members"
      />
    </>
  );
}
