import { CircleUserIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Avatar, AvatarFallback } from "../components/ui/avatar.tsx";
import { Button } from "../components/ui/button.tsx";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.tsx";

export interface AccountMenuItem {
  /** Keys the item. */
  id: string;
  label: string;
  /** A decorative icon. */
  icon?: ReactNode;
  onSelect: () => void;
}

export interface AccountMenuProps {
  /** The name of the button that opens the menu, for example "Account". */
  label: string;
  items: readonly AccountMenuItem[];
}

/** The top bar's account button and the menu it opens. Choosing an item runs its action and closes the menu. */
export function AccountMenu({ label, items }: AccountMenuProps): ReactElement {
  return (
    <Menu>
      <MenuTrigger render={<Button aria-label={label} size="icon" variant="ghost" />}>
        <Avatar className="size-6">
          <AvatarFallback>
            <CircleUserIcon aria-hidden="true" className="size-5" />
          </AvatarFallback>
        </Avatar>
      </MenuTrigger>
      <MenuPopup align="end">
        {items.map(({ id, label: itemLabel, icon, onSelect }) => (
          <MenuItem key={id} onClick={onSelect}>
            {icon}
            {itemLabel}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
