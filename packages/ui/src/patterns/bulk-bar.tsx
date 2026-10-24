import type { ReactElement, ReactNode } from "react";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Toolbar, ToolbarButton } from "../components/ui/toolbar.tsx";

export interface BulkBarAction {
  /** Keys the action. */
  id: string;
  label: string;
  /** A decorative icon. */
  icon?: ReactNode;
  /** Marks an action that removes something. */
  destructive?: boolean;
  /** Shows that this action is the one running. */
  loading?: boolean;
  onSelect: () => void;
}

export interface BulkBarProps {
  /** Names the toolbar for assistive technology. */
  label: string;
  /** How many items are selected, as the member reads it ("14 selected"). */
  count: ReactNode;
  /** What the bar says or offers beside the count, for example "Select all 40 matching". */
  children?: ReactNode;
  actions: readonly BulkBarAction[];
  /** Whether an action is running: no action can be started meanwhile. */
  busy?: boolean;
  /** Clears the selection. */
  clear: { label: string; onClear: () => void };
}

export interface BulkBarButtonProps {
  children: ReactNode;
  disabled?: boolean;
  /** Shows that the button's request is running. */
  loading?: boolean;
  onClick: () => void;
}

/** A ghost button for what a bulk bar says about the selection; it takes part in the toolbar's arrow-key focus movement. */
export function BulkBarButton({ children, disabled, loading, onClick }: BulkBarButtonProps): ReactElement {
  return (
    <ToolbarButton disabled={disabled} onClick={onClick} render={<Button loading={loading === true} size="sm" variant="ghost" />}>
      {children}
    </ToolbarButton>
  );
}

/**
 * The bar that appears while items are selected (doc 03 `bulk-bar`): a toolbar with the count in a Badge, room for
 * what is said about the selection, the actions that apply to all of it and a way to clear it. The arrow keys move
 * focus between its buttons. While an action runs the others wait and the running one shows the wait.
 */
export function BulkBar({ label, count, children, actions, busy = false, clear }: BulkBarProps): ReactElement {
  return (
    <Toolbar
      aria-busy={busy}
      aria-label={label}
      className="sticky bottom-4 z-20 flex-wrap items-center bg-popover p-2 text-popover-foreground shadow-lg/10"
      data-slot="bulk-bar"
    >
      <Badge variant="secondary">{count}</Badge>
      {children}
      <div className="ms-auto flex flex-wrap items-center gap-2">
        {actions.map((action) => (
          <ToolbarButton
            disabled={busy && action.loading !== true}
            key={action.id}
            onClick={action.onSelect}
            render={<Button loading={action.loading === true} size="sm" variant={action.destructive === true ? "destructive-outline" : "outline"} />}
          >
            {action.icon}
            {action.label}
          </ToolbarButton>
        ))}
        <ToolbarButton disabled={busy} onClick={clear.onClear} render={<Button size="sm" variant="ghost" />}>
          {clear.label}
        </ToolbarButton>
      </div>
    </Toolbar>
  );
}
