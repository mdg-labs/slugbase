import type { StoryDefault } from "@ladle/react";
import { DataTable, StatusBadge, type DataTableColumn } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Data table",
  parameters: { subject: ["DataTable"] },
} satisfies StoryDefault;

interface Row {
  id: string;
  device: string;
  network: string;
  current: boolean;
}

const ROWS: readonly Row[] = [
  { id: "1", device: "Firefox", network: "203.0", current: true },
  { id: "2", device: "Chrome", network: "198.51", current: false },
];

const COLUMNS: readonly DataTableColumn<Row>[] = [
  {
    id: "device",
    header: "Device",
    cell: (row) => (
      <span className="flex items-center gap-2">
        {row.device}
        {row.current ? <StatusBadge variant="info">This device</StatusBadge> : null}
      </span>
    ),
  },
  { id: "network", header: "Network", cell: (row) => <span className="font-mono text-xs">{row.network}</span> },
];

export const Default = (): React.ReactElement => <DataTable columns={COLUMNS} label="Sessions" rowKey={(row) => row.id} rows={ROWS} />;
