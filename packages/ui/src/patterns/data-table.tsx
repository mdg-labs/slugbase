import { tableFeatures, useTable, type ColumnDef } from "@tanstack/react-table";
import { useMemo, type ReactElement, type ReactNode } from "react";
import { Card, CardFrame } from "../components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { useIsMobile } from "../hooks/use-media-query.ts";
import { cn } from "../lib/utils.ts";

export interface DataTableColumn<Row extends object> {
  /** Keys the column. */
  id: string;
  header: ReactNode;
  /** Keeps the header from showing while it still names the column to assistive technology, for a column of actions. */
  hideHeader?: boolean;
  cell: (row: Row) => ReactNode;
  className?: string;
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
 * A read-only table of records (doc 03 `data-table`): a coss Table in a CardFrame, its rows modelled by TanStack
 * Table. On a narrow screen each row becomes a card that lists the columns under their headers, the first column as
 * its title.
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
    const [title, ...rest] = headers;
    return (
      <ul aria-label={label} className={cn("flex flex-col gap-3", className)} data-slot="data-table">
        {table.getRowModel().rows.map((row) => {
          const cells = row.getAllCells();
          const titleCell = cells.find((cell) => cell.column.id === title?.column.id);
          return (
            <li key={row.id}>
              <Card className="gap-3 p-4">
                {titleCell === undefined ? null : (
                  <div className="font-medium text-sm">
                    <table.FlexRender cell={titleCell} />
                  </div>
                )}
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  {rest.map((header) => {
                    const cell = cells.find((candidate) => candidate.column.id === header.column.id);
                    return (
                      <div className="col-span-2 grid grid-cols-subgrid items-center" key={header.id}>
                        <dt className={cn("text-muted-foreground", options.get(header.column.id)?.hideHeader === true && "sr-only")}>
                          <table.FlexRender header={header} />
                        </dt>
                        <dd className="min-w-0 justify-self-end">{cell === undefined ? null : <table.FlexRender cell={cell} />}</dd>
                      </div>
                    );
                  })}
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
            {headers.map((header) => (
              <TableHead className={options.get(header.column.id)?.className} key={header.id}>
                <span className={cn(options.get(header.column.id)?.hideHeader === true && "sr-only")}>
                  <table.FlexRender header={header} />
                </span>
              </TableHead>
            ))}
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
