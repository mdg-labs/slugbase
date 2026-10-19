import { EllipsisIcon } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import { Drawer, DrawerHeader, DrawerMenu, DrawerMenuItem, DrawerPopup, DrawerTitle, DrawerTrigger } from "../components/ui/drawer.tsx";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.tsx";
import { useIsMobile } from "../hooks/use-media-query.ts";

export interface RowAction {
  /** Keys the action. */
  id: string;
  label: string;
  /** A decorative icon. */
  icon?: ReactNode;
  /** Marks an action that removes something. */
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface RowActionsProps {
  /** Names the button that opens the actions, and the sheet on a narrow screen; it says whose row they are for. */
  label: string;
  actions: readonly RowAction[];
}

/**
 * The actions of one row or card (doc 03 `row-actions`): a menu from an icon button, and a bottom Drawer below the
 * `md` breakpoint. Choosing an action closes the menu and runs it. A row with no actions shows no button.
 */
export function RowActions({ label, actions }: RowActionsProps): ReactElement | null {
  const narrow = useIsMobile();
  const [open, setOpen] = useState(false);
  if (actions.length === 0) {
    return null;
  }
  const trigger = (
    <Button aria-label={label} data-slot="row-actions" size="icon" variant="ghost">
      <EllipsisIcon aria-hidden="true" />
    </Button>
  );
  if (narrow) {
    return (
      <Drawer onOpenChange={setOpen} open={open}>
        <DrawerTrigger render={trigger} />
        <DrawerPopup>
          <DrawerHeader>
            <DrawerTitle>{label}</DrawerTitle>
          </DrawerHeader>
          <DrawerMenu aria-label={label} className="m-0 px-4 pb-4">
            {actions.map(({ id, label: actionLabel, icon, destructive = false, disabled = false, onSelect }) => (
              <DrawerMenuItem
                disabled={disabled}
                key={id}
                onClick={() => {
                  setOpen(false);
                  onSelect();
                }}
                variant={destructive ? "destructive" : "default"}
              >
                {icon}
                {actionLabel}
              </DrawerMenuItem>
            ))}
          </DrawerMenu>
        </DrawerPopup>
      </Drawer>
    );
  }
  return (
    <Menu>
      <MenuTrigger render={trigger} />
      <MenuPopup align="end">
        {actions.map(({ id, label: actionLabel, icon, destructive = false, disabled = false, onSelect }) => (
          <MenuItem disabled={disabled} key={id} onClick={onSelect} variant={destructive ? "destructive" : "default"}>
            {icon}
            {actionLabel}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
