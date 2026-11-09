import { FlexRender, tableFeatures, useTable, type ColumnDef, type Row as ModelRow } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { memo, useMemo, type ReactElement, type ReactNode } from "react";
import { Card, CardFrame } from "../components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { useIsMobile } from "../hooks/use-media-query.ts";
import { cn } from "../lib/utils.ts";
import { listRoles } from "./list-roles.ts";

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
  /**
   * Keys a row; it must stay the same for the same record. A row is drawn again only when its record object, its
   * `rowSelected` answer or its tab stop changed, or the columns did: a record changed in place is not drawn again, so a
   * changed record must be a new object, and `columns` should be the same array from one render to the next while they
   * are unchanged (`useMemo`) or every row is drawn again.
   */
  rowKey: (row: Row) => string;
  /** Marks the rows that are selected; the column that selects them is the caller's. */
  rowSelected?: (row: Row) => boolean;
  /** Whether anything is selected: the table is an ARIA grid then (doc 03 section 15) and keeps its table role otherwise. */
  selectionActive?: boolean;
  /**
   * The key of the row that is the one stop of the table on the Tab key (a roving tabindex): that row is focusable by
   * Tab and the others only by script, which the arrow keys use. Left out, the rows are not focusable on their own.
   */
  tabStopId?: string;
  className?: string;
}

const features = tableFeatures({});

type Roles = ReturnType<typeof listRoles>;
type ColumnOptions<Row extends object> = ReadonlyMap<string, DataTableColumn<Row>>;

/** Where each column goes on a card, by column id. */
interface CardLayout {
  readonly title: string | undefined;
  readonly leading: readonly string[];
  readonly trailing: readonly string[];
  readonly rest: readonly string[];
}

function cardLayoutOf<Row extends object>(columns: readonly DataTableColumn<Row>[]): CardLayout {
  const title = columns.find((column) => column.cardSlot === "title") ?? columns.find((column) => column.cardSlot === undefined);
  const leading = columns.filter((column) => column.cardSlot === "leading");
  const trailing = columns.filter((column) => column.cardSlot === "trailing");
  const rest = columns.filter((column) => column !== title && !leading.includes(column) && !trailing.includes(column));
  const ids = (list: readonly DataTableColumn<Row>[]): string[] => list.map((column) => column.id);
  return { title: title?.id, leading: ids(leading), trailing: ids(trailing), rest: ids(rest) };
}

interface RowProps<Row extends object> {
  readonly row: ModelRow<typeof features, Row>;
  readonly options: ColumnOptions<Row>;
  readonly selected: boolean;
  readonly tabIndex: 0 | -1 | undefined;
}

type CardRowProps<Row extends object> = RowProps<Row> & { readonly layout: CardLayout; readonly roles: Roles };

// The table builds new row objects whenever its data array is a new one, so a row is told apart by its record.
function sameRow<Row extends object>(previous: RowProps<Row>, next: RowProps<Row>): boolean {
  return previous.row.original === next.row.original && previous.row.id === next.row.id && previous.options === next.options && previous.selected === next.selected && previous.tabIndex === next.tabIndex;
}

function sameCardRow<Row extends object>(previous: CardRowProps<Row>, next: CardRowProps<Row>): boolean {
  return sameRow(previous, next) && previous.layout === next.layout && previous.roles.row === next.roles.row && previous.roles.cell === next.roles.cell;
}

function TableBodyRowView<Row extends object>({ row, options, selected, tabIndex }: RowProps<Row>): ReactElement {
  return (
    <TableRow
      className="outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      data-item-id={row.id}
      data-state={selected ? "selected" : undefined}
      {...(tabIndex === undefined ? {} : { tabIndex })}
    >
      {row.getAllCells().map((cell) => (
        <TableCell className={options.get(cell.column.id)?.className} key={cell.id}>
          <FlexRender cell={cell} />
        </TableCell>
      ))}
    </TableRow>
  );
}

function CardRowView<Row extends object>({ row, options, selected, tabIndex, layout, roles }: CardRowProps<Row>): ReactElement {
  const cells = row.getAllCells();
  const renderCell = (columnId: string): ReactNode => {
    const cell = cells.find((candidate) => candidate.column.id === columnId);
    return cell === undefined ? null : <FlexRender cell={cell} />;
  };
  return (
    <div className="group/row outline-none" data-item-id={row.id} role={roles.row} {...(tabIndex === undefined ? {} : { tabIndex })}>
      <div role={roles.cell}>
        <Card className="gap-3 p-4 group-focus-visible/row:ring-2 group-focus-visible/row:ring-ring data-[selected=true]:ring-2 data-[selected=true]:ring-primary/60" data-selected={selected ? "true" : undefined}>
          <div className="flex items-start gap-3">
            {layout.leading.map((id) => (
              <div key={id}>{renderCell(id)}</div>
            ))}
            <div className="min-w-0 flex-1 font-medium text-sm">{layout.title === undefined ? null : renderCell(layout.title)}</div>
            {layout.trailing.map((id) => (
              <div key={id}>{renderCell(id)}</div>
            ))}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            {layout.rest.map((id) => (
              <div className="col-span-2 grid grid-cols-subgrid items-center" key={id}>
                <dt className={cn("text-muted-foreground", options.get(id)?.hideHeader === true && "sr-only")}>{options.get(id)?.header}</dt>
                <dd className="min-w-0 justify-self-end">{renderCell(id)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}

// The memo keeps a selection change, a new tab stop or a sort from drawing every row of the page; `memo` loses the generic, which the casts give back.
const TableBodyRow = memo(TableBodyRowView, sameRow) as typeof TableBodyRowView;
const CardRow = memo(CardRowView, sameCardRow) as typeof CardRowView;

/**
 * A table of records (doc 03 `data-table`): a coss Table in a CardFrame, its rows modelled by TanStack Table. A column
 * can order the rows from its header. On a narrow screen each row becomes a card that lists the columns under their
 * headers, the first column without a card slot as its title. A row is drawn again only when its record, whether it is
 * selected, its tab stop or the columns changed.
 */
export function DataTable<Row extends object>({ label, columns, rows, rowKey, rowSelected, selectionActive = false, tabStopId, className }: DataTableProps<Row>): ReactElement {
  const roles = listRoles(selectionActive);
  const tabIndexOf = (id: string): 0 | -1 | undefined => (tabStopId === undefined ? undefined : id === tabStopId ? 0 : -1);
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
  const options = useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns]);
  const layout = useMemo(() => cardLayoutOf(columns), [columns]);
  const headers = table.getHeaderGroups().flatMap((group) => group.headers);

  if (narrow) {
    return (
      <div aria-label={label} className={cn("flex flex-col gap-3", className)} data-slot="data-table" role={roles.list}>
        {table.getRowModel().rows.map((row) => (
          <CardRow
            key={row.id}
            layout={layout}
            options={options}
            roles={roles}
            row={row}
            selected={rowSelected?.(row.original) === true}
            tabIndex={tabIndexOf(row.id)}
          />
        ))}
      </div>
    );
  }
  return (
    <CardFrame className={className} data-slot="data-table">
      <Table aria-label={label} role={selectionActive ? "grid" : undefined} variant="card">
        <TableHeader>
          <TableRow>
            {headers.map((header) => {
              const column = options.get(header.column.id);
              const content = (
                <span className={cn(column?.hideHeader === true && "sr-only")}>
                  <FlexRender header={header} />
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
            <TableBodyRow key={row.id} options={options} row={row} selected={rowSelected?.(row.original) === true} tabIndex={tabIndexOf(row.id)} />
          ))}
        </TableBody>
      </Table>
    </CardFrame>
  );
}
