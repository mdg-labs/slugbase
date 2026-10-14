import { useRender } from "@base-ui/react/use-render";
import type { ReactElement, ReactNode } from "react";
import { Card } from "../components/ui/card.tsx";
import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.tsx";
import { useIsMobile } from "../hooks/use-media-query.ts";
import { cn } from "../lib/utils.ts";

export interface SettingsNavItem {
  /** Keys the item and names it to `onNavigate`. */
  id: string;
  label: string;
  /** The link to render, for example `<Link to="/settings/account" />`; the pattern sets its class, its label and `aria-current`. */
  link: ReactElement;
  /** Whether the item is the page being shown. */
  current?: boolean;
}

export interface SettingsNavGroup {
  id: string;
  /** Written above the group's links. */
  label: string;
  items: readonly SettingsNavItem[];
}

export interface SettingsNavProps {
  /** Names the navigation landmark, and the Select that replaces it on a narrow screen. */
  label: string;
  groups: readonly SettingsNavGroup[];
  /** Called with the id of the item a narrow screen's Select chose; the app goes to its page. */
  onNavigate: (id: string) => void;
  /** Below the groups on a wide screen, for the links an extension adds. */
  footer?: ReactNode;
  className?: string;
}

function NavLink({ item }: { item: SettingsNavItem }): ReactElement {
  return useRender({
    defaultTagName: "a",
    render: item.link,
    props: {
      "aria-current": item.current === true ? "page" : undefined,
      children: item.label,
      className: cn(
        "block rounded-md px-2.5 py-1.5 text-muted-foreground text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-accent-foreground",
      ),
    },
  });
}

/**
 * The left navigation of the settings and admin pages (doc 03 section 11): the links in groups with
 * labels, in a card. Below the `md` breakpoint it becomes a Select of the same pages, which calls
 * `onNavigate` with the chosen id.
 */
export function SettingsNav({ label, groups, onNavigate, footer, className }: SettingsNavProps): ReactElement {
  const narrow = useIsMobile();
  if (narrow) {
    const all = groups.flatMap((group) => group.items);
    const current = all.find((item) => item.current === true);
    const items = all.map(({ id, label: itemLabel }) => ({ value: id, label: itemLabel }));
    return (
      <div className={className}>
        <Select
          items={items}
          onValueChange={(next) => {
            if (next !== null) {
              onNavigate(next);
            }
          }}
          value={current?.id ?? ""}
        >
          <SelectTrigger aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {groups.map((group) => (
              <SelectGroup key={group.id}>
                <SelectGroupLabel>{group.label}</SelectGroupLabel>
                {group.items.map((item) => (
                  <SelectItem key={item.id} label={item.label} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectPopup>
        </Select>
      </div>
    );
  }
  return (
    <Card className={cn("p-2", className)}>
      <nav aria-label={label} className="flex flex-col gap-4">
        {groups.map((group) => (
          <div className="flex flex-col gap-0.5" key={group.id}>
            <p aria-hidden="true" className="px-2.5 py-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
              {group.label}
            </p>
            <ul aria-label={group.label} className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.id}>
                  <NavLink item={item} />
                </li>
              ))}
            </ul>
          </div>
        ))}
        {footer}
      </nav>
    </Card>
  );
}
