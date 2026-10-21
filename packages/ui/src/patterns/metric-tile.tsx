import type { ReactElement, ReactNode } from "react";
import { Card, CardPanel } from "../components/ui/card.tsx";
import { cn } from "../lib/utils.ts";

export interface MetricTileProps {
  /** What the value counts. */
  label: ReactNode;
  /** The figure, already formatted for the language. */
  value: ReactNode;
  className?: string;
}

/** One figure with its label in a card (doc 03 `metric-tile`), for the counts of a dashboard or an overview. */
export function MetricTile({ label, value, className }: MetricTileProps): ReactElement {
  return (
    <Card className={cn("min-w-0", className)}>
      <CardPanel className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">{label}</p>
        <p className="truncate font-semibold text-3xl tabular-nums">{value}</p>
      </CardPanel>
    </Card>
  );
}
