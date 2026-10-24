import { ContextMenu } from "@base-ui/react/context-menu";
import type { ReactElement, ReactNode } from "react";
import { MenuItem, MenuPopup } from "../components/ui/menu.tsx";
import type { RowAction } from "./row-actions.tsx";

export interface ContextActionsProps {
  /** Names the menu for assistive technology; it says whose actions they are. */
  label: string;
  /** The same list the row's `RowActions` takes, so the two menus can never differ. */
  actions: readonly RowAction[];
  className?: string;
  /** The area a right click or a long press opens the menu over. */
  children: ReactNode;
}

/**
 * The context menu of a row or card (doc 03 `context-actions`): the actions of `RowActions` in a menu that opens
 * where the pointer is. The area stays an ordinary element, so what it holds keeps its own behaviour. With no actions
 * it is the bare area.
 */
export function ContextActions({ label, actions, className, children }: ContextActionsProps): ReactElement {
  if (actions.length === 0) {
    return <div className={className}>{children}</div>;
  }
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger className={className} data-slot="context-actions">
        {children}
      </ContextMenu.Trigger>
      <MenuPopup aria-label={label} side="right" align="start" sideOffset={0}>
        {actions.map(({ id, label: actionLabel, icon, destructive = false, disabled = false, onSelect }) => (
          <MenuItem disabled={disabled} key={id} onClick={onSelect} variant={destructive ? "destructive" : "default"}>
            {icon}
            {actionLabel}
          </MenuItem>
        ))}
      </MenuPopup>
    </ContextMenu.Root>
  );
}
