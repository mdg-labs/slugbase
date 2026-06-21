import { useState } from "react";
import { Link } from "react-router";

import { listWorkspaces } from "../api/client.js";
import type { WorkspaceListItem } from "../api/types.js";
import { BookmarkCapMeter } from "../components/BookmarkCapMeter.js";
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

const columns: DataTableColumn<WorkspaceListItem>[] = [
  {
    key: "name",
    header: "Name",
    render: (row) => (
      <Link to={`/workspaces/${row.id}`} style={{ color: "var(--accent-text)" }}>
        {row.name}
      </Link>
    ),
  },
  {
    key: "slug",
    header: "Slug",
    mono: true,
    render: (row) => row.slug,
  },
  {
    key: "plan",
    header: "Plan",
    mono: true,
    render: (row) => row.plan,
  },
  {
    key: "billing",
    header: "Billing",
    render: (row) => row.billingStatus ?? "—",
  },
  {
    key: "members",
    header: "Members",
    render: (row) => row.memberCount,
  },
  {
    key: "bookmarks",
    header: "Bookmarks",
    render: (row) =>
      row.plan === "free" ? (
        <BookmarkCapMeter active={row.activeBookmarkCount} compact />
      ) : (
        row.activeBookmarkCount
      ),
  },
  {
    key: "created",
    header: "Created",
    render: (row) => formatDate(row.createdAt),
  },
];

export function WorkspacesPage() {
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useAsyncData(
    () => listWorkspaces({ page, limit: 25 }),
    [page],
  );

  const totalPages = data
    ? Math.max(1, Math.ceil(data.pagination.total / data.pagination.limit))
    : 1;

  return (
    <>
      <PageHeader
        title="Workspaces"
        subtitle="Tenant directories with bookmark cap utilization on Free plans"
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
            emptyTitle="No workspaces"
            emptyDescription="Workspaces appear when users create them on Cloud."
          />
          <PaginationBar page={page} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </>
  );
}
