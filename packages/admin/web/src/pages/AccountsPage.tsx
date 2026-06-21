import { useState } from "react";
import { Link } from "react-router";

import { listAccounts } from "../api/client.js";
import type { AccountListItem } from "../api/types.js";
import { DataTable, PaginationBar, type DataTableColumn } from "../components/DataTable.js";
import { ErrorRetry } from "../components/Feedback.js";
import { PageHeader } from "../components/PageHeader.js";
import { useAsyncData } from "../hooks/useAsyncData.js";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const columns: DataTableColumn<AccountListItem>[] = [
  {
    key: "email",
    header: "Email",
    render: (row) => (
      <Link to={`/accounts/${row.id}`} style={{ color: "var(--accent-text)" }}>
        {row.email}
      </Link>
    ),
  },
  {
    key: "name",
    header: "Name",
    render: (row) => row.name || "—",
  },
  {
    key: "created",
    header: "Created",
    render: (row) => formatDate(row.createdAt),
  },
  {
    key: "verified",
    header: "Verified",
    render: (row) => (row.emailVerified ? "Yes" : "No"),
  },
  {
    key: "mfa",
    header: "MFA",
    mono: true,
    render: (row) => row.mfaState,
  },
  {
    key: "workspaces",
    header: "Workspaces",
    render: (row) => row.workspaceCount,
  },
];

export function AccountsPage() {
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useAsyncData(
    () => listAccounts({ page, limit: 25, sort: "created_at", order: "desc" }),
    [page],
  );

  const totalPages = data
    ? Math.max(1, Math.ceil(data.pagination.total / data.pagination.limit))
    : 1;

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="Product user accounts — read-only directory"
      />
      {error !== null ? (
        <ErrorRetry message={error} onRetry={reload} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={data?.items ?? []}
            rowKey={(row) => row.id}
            loading={loading}
            emptyTitle="No accounts"
            emptyDescription="Accounts appear here once users register on Cloud."
          />
          <PaginationBar page={page} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </>
  );
}
