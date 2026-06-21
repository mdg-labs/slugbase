import type { CSSProperties, ReactNode } from "react";

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "var(--text-sm)",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "var(--sp-2) var(--sp-3)",
  borderBottom: "1px solid var(--border)",
  color: "var(--fg-subtle)",
  fontWeight: 500,
  fontSize: "var(--text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const tdStyle: CSSProperties = {
  padding: "var(--sp-3)",
  borderBottom: "1px solid var(--border-subtle)",
  verticalAlign: "middle",
};

const wrapperStyle: CSSProperties = {
  background: "var(--raised)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-md)",
  overflow: "hidden",
};

export type DataTableColumn<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  mono?: boolean;
};

function SkeletonRow({ columns }: { columns: number }) {
  return (
    <tr data-testid="table-skeleton-row">
      {Array.from({ length: columns }, (_, index) => (
        <td key={index} style={tdStyle}>
          <div
            style={{
              height: 14,
              background: "var(--raised-2)",
              borderRadius: "var(--radius-sm)",
              width: index === 0 ? "70%" : "50%",
            }}
          />
        </td>
      ))}
    </tr>
  );
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 5,
  emptyTitle = "No rows",
  emptyDescription,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  skeletonRows?: number;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  if (loading) {
    return (
      <div style={wrapperStyle} data-testid="data-table-loading">
        <table style={tableStyle}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} style={thStyle}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: skeletonRows }, (_, index) => (
              <SkeletonRow key={index} columns={columns.length} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div style={wrapperStyle} data-testid="data-table-empty">
        <div style={{ padding: "var(--sp-8)" }}>
          <p style={{ margin: 0, fontWeight: 500, textAlign: "center" }}>{emptyTitle}</p>
          {emptyDescription !== undefined ? (
            <p
              style={{
                margin: "var(--sp-2) 0 0",
                color: "var(--fg-muted)",
                fontSize: "var(--text-sm)",
                textAlign: "center",
              }}
            >
              {emptyDescription}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div style={wrapperStyle} data-testid="data-table">
      <table style={tableStyle}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={thStyle}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  style={{
                    ...tdStyle,
                    fontFamily: column.mono ? "var(--font-mono)" : undefined,
                  }}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PaginationBar({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) {
    return null;
  }

  const buttonStyle: CSSProperties = {
    padding: "var(--sp-1) var(--sp-3)",
    background: "var(--raised-2)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-sm)",
    color: "var(--fg-muted)",
    fontSize: "var(--text-sm)",
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: "var(--sp-4)",
        fontSize: "var(--text-sm)",
        color: "var(--fg-muted)",
      }}
    >
      <span>
        Page {page} of {totalPages}
      </span>
      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <button
          type="button"
          style={buttonStyle}
          disabled={page <= 1}
          onClick={() => {
            onPageChange(page - 1);
          }}
        >
          Previous
        </button>
        <button
          type="button"
          style={buttonStyle}
          disabled={page >= totalPages}
          onClick={() => {
            onPageChange(page + 1);
          }}
        >
          Next
        </button>
      </div>
    </div>
  );
}
