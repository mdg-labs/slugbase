import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataTable, type DataTableColumn } from "../../src/patterns/index.ts";
import { expectNoViolations, stubMatchMedia } from "../support.tsx";

interface Row {
  id: string;
  name: string;
  size: number;
}

const ROWS: readonly Row[] = [
  { id: "a", name: "Alpha", size: 1 },
  { id: "b", name: "Beta", size: 2 },
];

const COLUMNS: readonly DataTableColumn<Row>[] = [
  { id: "name", header: "Name", cell: (row) => row.name },
  { id: "size", header: "Size", cell: (row) => String(row.size) },
  { id: "actions", header: "Actions", hideHeader: true, cell: (row) => <button type="button">{`Open ${row.name}`}</button> },
];

afterEach(() => {
  stubMatchMedia(false);
});

describe("DataTable", () => {
  it("is a table named by its label with a header per column and a row per record", async () => {
    stubMatchMedia(false);
    const { container } = render(<DataTable columns={COLUMNS} label="Files" rowKey={(row) => row.id} rows={ROWS} />);

    const table = screen.getByRole("table", { name: "Files" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Name", "Size", "Actions"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      ["Alpha", "1", "Open Alpha"],
      ["Beta", "2", "Open Beta"],
    ]);
    await expectNoViolations(container);
  });

  it("keeps the header of an action column for assistive technology only", () => {
    stubMatchMedia(false);
    render(<DataTable columns={COLUMNS} label="Files" rowKey={(row) => row.id} rows={ROWS} />);

    expect(screen.getByText("Actions").className).toContain("sr-only");
    expect(screen.getByText("Name").className).not.toContain("sr-only");
  });

  it("lists each row as a card with its columns under their headers on a narrow screen", async () => {
    stubMatchMedia(true);
    const { container } = render(<DataTable columns={COLUMNS} label="Files" rowKey={(row) => row.id} rows={ROWS} />);

    expect(screen.queryByRole("table")).toBeNull();
    const cards = within(screen.getByRole("list", { name: "Files" })).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[1] as HTMLElement).getByText("Beta")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText("Size")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByRole("button", { name: "Open Beta" })).toBeTruthy();
    await expectNoViolations(container);
  });
});
