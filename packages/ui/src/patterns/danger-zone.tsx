import type { ReactElement, ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "../components/ui/card.tsx";
import { cn } from "../lib/utils.ts";

export interface DangerZoneItem {
  /** Keys the item. */
  id: string;
  /** What the action does, in a few words. */
  title: ReactNode;
  /** The consequence, and anything that keeps the action from being offered. */
  description: ReactNode;
  /** The name of the destructive button. */
  actionLabel: ReactNode;
  /** Called when the button is pressed; the item opens its `confirm` or `typed-confirm`, it does not act itself. */
  onSelect: () => void;
  disabled?: boolean;
  /** Shows the wait on the button. */
  loading?: boolean;
}

export interface DangerZoneProps {
  title: ReactNode;
  description?: ReactNode;
  items: readonly DangerZoneItem[];
  className?: string;
}

/**
 * The part of a settings page that holds the actions that cannot be taken back (doc 03 `danger-zone`): a framed
 * section whose rows each name an action, say what it costs, and carry a destructive-outline button that opens the
 * confirmation.
 */
export function DangerZone({ title, description, items, className }: DangerZoneProps): ReactElement {
  return (
    <Card className={cn("border-destructive/32", className)} data-slot="danger-zone">
      <CardHeader>
        <CardTitle render={<h2 />}>{title}</CardTitle>
        {description === undefined ? null : <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardPanel>
        <ul className="flex flex-col divide-y">
          {items.map((item) => (
            <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between" key={item.id}>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-sm">{item.title}</span>
                <span className="text-muted-foreground text-sm">{item.description}</span>
              </div>
              <Button className="shrink-0" disabled={item.disabled} loading={item.loading} onClick={item.onSelect} variant="destructive-outline">
                {item.actionLabel}
              </Button>
            </li>
          ))}
        </ul>
      </CardPanel>
    </Card>
  );
}
