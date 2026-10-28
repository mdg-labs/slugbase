import { createContext, use, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { Card } from "../components/ui/card.tsx";
import { cn } from "../lib/utils.ts";
import { Favicon } from "./favicon.tsx";
import { listRoles } from "./list-roles.ts";
import { ContextActions } from "./context-actions.tsx";
import { RowActions, type RowAction } from "./row-actions.tsx";
import { SelectCheckbox } from "./select-checkbox.tsx";

const SelectionActiveContext = createContext(false);

export interface CardGridProps {
  /** Names the list for assistive technology. */
  label: string;
  /** Whether anything in the list is selected: the grid is an ARIA grid then and a list otherwise. */
  selectionActive?: boolean;
  /** `CardGridItem`s. */
  children: ReactNode;
}

/**
 * A responsive grid of cards, one column on a phone (doc 03 `card-grid`). It is a list, so assistive technology counts its
 * cards, and an ARIA grid while a selection is active (doc 03 section 15).
 */
export function CardGrid({ label, selectionActive = false, children }: CardGridProps): ReactElement {
  return (
    <div aria-label={label} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" data-slot="card-grid" role={listRoles(selectionActive).list}>
      <SelectionActiveContext value={selectionActive}>{children}</SelectionActiveContext>
    </div>
  );
}

export interface CardGridItemProps {
  /** The card's title, at most two lines. It is shown as text, whatever it holds. */
  title: string;
  /** Where the card leads. The title is a link to it, in the same tab; omitted, the title is plain text. */
  href?: string;
  /** Called when the link is followed, with a click or a middle click, before the browser navigates. It must not delay the navigation. */
  onOpen?: () => void;
  /** The host the card's icon is drawn for; the favicon of the host, or its monogram when it has none. */
  host: string;
  /** A line in mono under the title, for an address or a host. It is not translated. */
  subtitle?: string;
  /** Marks beside the actions, for example a pin. */
  indicator?: ReactNode;
  /** The rest of the card, under the title. */
  children?: ReactNode;
  /** What can be done to the card; the menu button and the context menu show this one list. */
  actions: readonly RowAction[];
  /** Names the menu button and the context menu, and says whose they are. */
  actionsLabel: string;
  /** Names the checkbox that appears on hover or focus. */
  selectLabel: string;
  /** Tells the list which card this is: it is set as `data-item-id`, which the page reads to find the card that holds focus. */
  itemId?: string;
  /** Whether the card is selected; left out, the checkbox keeps its own state. */
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /** Shows every checkbox, not only those of cards that are hovered or focused, as long as anything in the list is selected. */
  selectionActive?: boolean;
  /**
   * Makes the card the one stop of the list on the Tab key (a roving tabindex): `true` for that card and `false` for the
   * others, which the arrow keys reach. Left out, the card is not focusable on its own.
   */
  tabStop?: boolean;
}

/**
 * One card of a `CardGrid`: the favicon of its host, the title as the link, a subtitle in mono and the content under them, with a
 * checkbox that appears on hover or focus and the card's actions in a menu button and a context menu. The whole card
 * follows the link; the checkbox and the menu button keep their own clicks. A card is selected by its checkbox.
 */
export function CardGridItem({ title, href, onOpen, host, subtitle, indicator, children, actions, actionsLabel, selectLabel, itemId, selected, onSelectedChange, selectionActive = false, tabStop }: CardGridItemProps): ReactElement {
  const roles = listRoles(use(SelectionActiveContext));
  return (
    <div className="group/card outline-none" data-item-id={itemId} role={roles.row} {...(tabStop === undefined ? {} : { tabIndex: tabStop ? 0 : -1 })}>
      <div className="h-full" role={roles.cell}>
        <ContextActions actions={actions} className="h-full" label={actionsLabel}>
          <Card
            className="h-full gap-2 p-4 transition-colors focus-within:ring-2 focus-within:ring-ring group-focus-visible/card:ring-2 group-focus-visible/card:ring-ring hover:bg-accent/30 data-[selected=true]:bg-accent/40 data-[selected=true]:ring-2 data-[selected=true]:ring-primary/60"
            data-selected={selected === true ? "true" : undefined}
          >
            <div className="flex items-start gap-3">
              <Favicon host={host} size={32} />
              <div className="min-w-0 flex-1">
                <h2 className="line-clamp-2 font-medium text-sm wrap-anywhere">
                  {href === undefined ? (
                    title
                  ) : (
                    <a
                      className="rounded-sm outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
                      href={href}
                      onAuxClick={(event: MouseEvent<HTMLAnchorElement>) => {
                        if (event.button === 1) {
                          onOpen?.();
                        }
                      }}
                      onClick={() => {
                        onOpen?.();
                      }}
                      rel="noopener noreferrer"
                    >
                      {title}
                    </a>
                  )}
                </h2>
                {subtitle === undefined ? null : (
                  <p className="truncate font-mono text-muted-foreground text-xs" translate="no">
                    {subtitle}
                  </p>
                )}
              </div>
              <div className="relative z-10 -mt-1.5 -me-1.5 flex items-center gap-1">
                {indicator}
                <SelectCheckbox
                  {...(selected === undefined ? {} : { checked: selected })}
                  className={cn(
                    "transition-opacity focus-visible:opacity-100 group-focus-within/card:opacity-100 group-hover/card:opacity-100",
                    selectionActive ? "opacity-100" : "opacity-0",
                  )}
                  label={selectLabel}
                  {...(onSelectedChange === undefined ? {} : { onCheckedChange: onSelectedChange })}
                />
                <RowActions actions={actions} label={actionsLabel} />
              </div>
            </div>
            {children}
          </Card>
        </ContextActions>
      </div>
    </div>
  );
}
