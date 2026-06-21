import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DataTable } from "./DataTable.js";

type Row = { id: string; label: string };

const columns = [
  {
    key: "label",
    header: "Label",
    render: (row: Row) => row.label,
  },
];

describe("DataTable", () => {
  it("renders empty state when there are no rows", () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        emptyTitle="No rows yet"
        emptyDescription="Data will appear here."
      />,
    );

    expect(screen.getByTestId("data-table-empty")).toBeTruthy();
    expect(screen.getByText("No rows yet")).toBeTruthy();
    expect(screen.getByText("Data will appear here.")).toBeTruthy();
  });

  it("renders skeleton rows while loading", () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        loading
        skeletonRows={3}
      />,
    );

    expect(screen.getByTestId("data-table-loading")).toBeTruthy();
    expect(screen.getAllByTestId("table-skeleton-row")).toHaveLength(3);
  });
});
