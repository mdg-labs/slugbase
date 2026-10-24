import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("orders from a sortable header, says how the rows are ordered and leaves other headers plain", () => {
    stubMatchMedia(false);
    const onSort = vi.fn();
    const columns: readonly DataTableColumn<Row>[] = [
      { id: "name", header: "Name", cell: (row) => row.name, sort: { direction: "ascending", onSort } },
      { id: "size", header: "Size", cell: (row) => String(row.size), sort: { direction: "none", onSort: () => undefined } },
      { id: "plain", header: "Plain", cell: () => "" },
    ];
    render(<DataTable columns={columns} label="Files" rowKey={(row) => row.id} rows={ROWS} />);

    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((header) => header.getAttribute("aria-sort"))).toEqual(["ascending", "none", null]);
    expect(within(headers[2] as HTMLElement).queryByRole("button")).toBeNull();
    fireEvent.click(within(headers[0] as HTMLElement).getByRole("button", { name: "Name" }));
    expect(onSort).toHaveBeenCalledTimes(1);
  });

  it("puts the leading and trailing columns of a card beside its title and the rest under it", () => {
    stubMatchMedia(true);
    const columns: readonly DataTableColumn<Row>[] = [
      { id: "pick", header: "Pick", hideHeader: true, cardSlot: "leading", cell: (row) => <input aria-label={`Pick ${row.name}`} type="checkbox" /> },
      { id: "name", header: "Name", cell: (row) => row.name },
      { id: "size", header: "Size", cell: (row) => String(row.size) },
      { id: "actions", header: "Actions", hideHeader: true, cardSlot: "trailing", cell: (row) => <button type="button">{`Open ${row.name}`}</button> },
    ];
    render(<DataTable columns={columns} label="Files" rowKey={(row) => row.id} rows={ROWS} />);

    const card = within(screen.getByRole("list", { name: "Files" })).getAllByRole("listitem")[0] as HTMLElement;
    const row = card.querySelector("div.flex") as HTMLElement;
    expect(within(row).getByRole("checkbox", { name: "Pick Alpha" })).toBeTruthy();
    expect(within(row).getByText("Alpha")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Open Alpha" })).toBeTruthy();
    expect(within(card.querySelector("dl") as HTMLElement).getAllByRole("term").map((term) => term.textContent)).toEqual(["Size"]);
  });

  it("marks the selected rows and names every row for the page", () => {
    stubMatchMedia(false);
    render(<DataTable columns={COLUMNS} label="Files" rowKey={(row) => row.id} rowSelected={(row) => row.id === "b"} rows={ROWS} />);

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.getAttribute("data-state"))).toEqual([null, "selected"]);
    expect(rows.map((row) => row.getAttribute("data-item-id"))).toEqual(["a", "b"]);
  });
});
