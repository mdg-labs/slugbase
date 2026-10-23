import type { MouseEvent, ReactElement, ReactNode } from "react";
import { Card } from "../components/ui/card.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { ContextActions } from "./context-actions.tsx";
import { RowActions, type RowAction } from "./row-actions.tsx";

export interface CardGridProps {
  /** Names the list for assistive technology. */
  label: string;
  /** `CardGridItem`s. */
  children: ReactNode;
}

/** A responsive grid of cards, one column on a phone (doc 03 `card-grid`). It is a list, so assistive technology counts its cards. */
export function CardGrid({ label, children }: CardGridProps): ReactElement {
  return (
    <ul aria-label={label} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" data-slot="card-grid">
      {children}
    </ul>
  );
}

export interface CardGridItemProps {
  /** The card's title, at most two lines. It is shown as text, whatever it holds. */
  title: string;
  /** Where the card leads. The title is a link to it, in the same tab; omitted, the title is plain text. */
  href?: string;
  /** Called when the link is followed, with a click or a middle click, before the browser navigates. It must not delay the navigation. */
  onOpen?: () => void;
  /** The letter that stands in for a picture. */
  monogram: string;
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
}

/**
 * One card of a `CardGrid`: a monogram, the title as the link, a subtitle in mono and the content under them, with a
 * checkbox that appears on hover or focus and the card's actions in a menu button and a context menu. The whole card
 * follows the link; the checkbox and the menu button keep their own clicks.
 */
export function CardGridItem({ title, href, onOpen, monogram, subtitle, indicator, children, actions, actionsLabel, selectLabel }: CardGridItemProps): ReactElement {
  return (
    <li className="group/card">
      <ContextActions actions={actions} className="h-full" label={actionsLabel}>
        <Card className="h-full gap-2 p-4 transition-colors focus-within:ring-2 focus-within:ring-ring hover:bg-accent/30">
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid size-9 shrink-0 place-items-center rounded-md bg-muted font-medium text-muted-foreground text-sm uppercase"
              translate="no"
            >
              {monogram}
            </span>
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
              <Checkbox
                aria-label={selectLabel}
                className="opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/card:opacity-100 group-hover/card:opacity-100"
              />
              <RowActions actions={actions} label={actionsLabel} />
            </div>
          </div>
          {children}
        </Card>
      </ContextActions>
    </li>
  );
}
