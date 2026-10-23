import { tableFeatures, useTable, type ColumnDef } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { useMemo, type ReactElement, type ReactNode } from "react";
import { Card, CardFrame } from "../components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { useIsMobile } from "../hooks/use-media-query.ts";
import { cn } from "../lib/utils.ts";

/** How a sortable column is ordered now: the ARIA `aria-sort` values. */
export type DataTableSortDirection = "ascending" | "descending" | "none";

/** Where a column goes when a row is shown as a card: beside the title on its left or its right, or as the title. */
export type DataTableCardSlot = "leading" | "title" | "trailing";

export interface DataTableColumn<Row extends object> {
  /** Keys the column. */
  id: string;
  header: ReactNode;
  /** Keeps the header from showing while it still names the column to assistive technology, for a column of actions. */
  hideHeader?: boolean;
  cell: (row: Row) => ReactNode;
  className?: string;
  /** Makes the header a button that orders the rows by this column; `direction` says how they are ordered now. The page holds the order. */
  sort?: { direction: DataTableSortDirection; onSort: () => void };
  /** Where the column goes on a card; by default the first column that has no slot is the title and the rest are listed under it. */
  cardSlot?: DataTableCardSlot;
}

export interface DataTableProps<Row extends object> {
  /** Names the table. */
  label: string;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  /** Keys a row; it must stay the same for the same record. */
  rowKey: (row: Row) => string;
  className?: string;
}

const features = tableFeatures({});

/**
 * A table of records (doc 03 `data-table`): a coss Table in a CardFrame, its rows modelled by TanStack Table. A column
 * can order the rows from its header. On a narrow screen each row becomes a card that lists the columns under their
 * headers, the first column without a card slot as its title.
 */
export function DataTable<Row extends object>({ label, columns, rows, rowKey, className }: DataTableProps<Row>): ReactElement {
  const narrow = useIsMobile();
  const columnDefs = useMemo(
    () =>
      columns.map(
        (column): ColumnDef<typeof features, Row> => ({
          id: column.id,
          header: () => column.header,
          cell: (context) => column.cell(context.row.original),
        }),
      ),
    [columns],
  );
  const data = useMemo(() => [...rows], [rows]);
  const table = useTable({ features, columns: columnDefs, data, getRowId: rowKey });
  const options = new Map(columns.map((column) => [column.id, column]));
  const headers = table.getHeaderGroups().flatMap((group) => group.headers);

  if (narrow) {
    const slotOf = (id: string): DataTableCardSlot | undefined => options.get(id)?.cardSlot;
    const title = headers.find((header) => slotOf(header.column.id) === "title") ?? headers.find((header) => slotOf(header.column.id) === undefined);
    const leading = headers.filter((header) => slotOf(header.column.id) === "leading");
    const trailing = headers.filter((header) => slotOf(header.column.id) === "trailing");
    const rest = headers.filter((header) => header !== title && !leading.includes(header) && !trailing.includes(header));
    return (
      <ul aria-label={label} className={cn("flex flex-col gap-3", className)} data-slot="data-table">
        {table.getRowModel().rows.map((row) => {
          const cells = row.getAllCells();
          const cellOf = (columnId: string) => cells.find((cell) => cell.column.id === columnId);
          const renderCell = (columnId: string): ReactNode => {
            const cell = cellOf(columnId);
            return cell === undefined ? null : <table.FlexRender cell={cell} />;
          };
          return (
            <li key={row.id}>
              <Card className="gap-3 p-4">
                <div className="flex items-start gap-3">
                  {leading.map((header) => (
                    <div key={header.id}>{renderCell(header.column.id)}</div>
                  ))}
                  <div className="min-w-0 flex-1 font-medium text-sm">{title === undefined ? null : renderCell(title.column.id)}</div>
                  {trailing.map((header) => (
                    <div key={header.id}>{renderCell(header.column.id)}</div>
                  ))}
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  {rest.map((header) => (
                    <div className="col-span-2 grid grid-cols-subgrid items-center" key={header.id}>
                      <dt className={cn("text-muted-foreground", options.get(header.column.id)?.hideHeader === true && "sr-only")}>
                        <table.FlexRender header={header} />
                      </dt>
                      <dd className="min-w-0 justify-self-end">{renderCell(header.column.id)}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <CardFrame className={className} data-slot="data-table">
      <Table aria-label={label} variant="card">
        <TableHeader>
          <TableRow>
            {headers.map((header) => {
              const column = options.get(header.column.id);
              const content = (
                <span className={cn(column?.hideHeader === true && "sr-only")}>
                  <table.FlexRender header={header} />
                </span>
              );
              return (
                <TableHead aria-sort={column?.sort?.direction} className={column?.className} key={header.id}>
                  {column?.sort === undefined ? (
                    content
                  ) : (
                    <button
                      className="-mx-1 inline-flex cursor-pointer items-center gap-1 rounded-sm px-1 py-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={column.sort.onSort}
                      type="button"
                    >
                      {content}
                      {column.sort.direction === "ascending" ? (
                        <ArrowUpIcon aria-hidden="true" className="size-3.5" />
                      ) : column.sort.direction === "descending" ? (
                        <ArrowDownIcon aria-hidden="true" className="size-3.5" />
                      ) : (
                        <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 opacity-64" />
                      )}
                    </button>
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getAllCells().map((cell) => (
                <TableCell className={options.get(cell.column.id)?.className} key={cell.id}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardFrame>
  );
}
