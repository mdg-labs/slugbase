import { Link } from "react-router";
import { useParams } from "react-router";

import { getAccount } from "../api/client.js";
import { DataTable, type DataTableColumn } from "../components/DataTable.js";
import type { AccountMembership } from "../api/types.js";
import { ErrorRetry } from "../components/Feedback.js";
import { PageHeader } from "../components/PageHeader.js";
import { useAsyncData } from "../hooks/useAsyncData.js";

const membershipColumns: DataTableColumn<AccountMembership>[] = [
  {
    key: "workspace",
    header: "Workspace",
    render: (row) => (
      <Link
        to={`/workspaces/${row.workspaceId}`}
        style={{ color: "var(--accent-text)" }}
      >
        {row.workspaceName}
      </Link>
    ),
  },
  {
    key: "role",
    header: "Role",
    mono: true,
    render: (row) => row.role,
  },
];

export function AccountDetailPage() {
  const { id = "" } = useParams();
  const { data, loading, error, reload } = useAsyncData(
    () => getAccount(id),
    [id],
  );

  if (error !== null) {
    return (
      <>
        <PageHeader title="Account" />
        <ErrorRetry message={error} onRetry={reload} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={loading ? "Loading…" : (data?.email ?? "Account")}
        subtitle={data?.name ?? undefined}
        actions={
          <Link to="/accounts" style={{ fontSize: "var(--text-sm)" }}>
            ← Back to accounts
          </Link>
        }
      />
      {data !== null ? (
        <div
          style={{
            display: "grid",
            gap: "var(--sp-2)",
            marginBottom: "var(--sp-6)",
            fontSize: "var(--text-sm)",
            color: "var(--fg-muted)",
          }}
        >
          <div>Verified: {data.emailVerified ? "Yes" : "No"}</div>
          <div>MFA: {data.mfaState}</div>
          <div>Workspaces: {data.workspaceCount}</div>
        </div>
      ) : null}
      <h3 style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)" }}>
        Workspace memberships
      </h3>
      <DataTable
        columns={membershipColumns}
        rows={data?.memberships ?? []}
        rowKey={(row) => row.workspaceId}
        loading={loading}
        emptyTitle="No workspace memberships"
      />
    </>
  );
}
