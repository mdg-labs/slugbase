import type { MouseEvent, ReactElement, ReactNode } from "react";
import { Card } from "../components/ui/card.tsx";
import { Favicon } from "./favicon.tsx";

export interface TileGridProps {
  /** Names the list for assistive technology. */
  label: string;
  /** `TileLink`s. */
  children: ReactNode;
}

/** A responsive grid of compact link tiles, two columns on a phone (doc 03 `card-grid`, compact variant). It is a list, so assistive technology counts its tiles. */
export function TileGrid({ label, children }: TileGridProps): ReactElement {
  return (
    <ul aria-label={label} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" data-slot="tile-grid">
      {children}
    </ul>
  );
}

export interface TileLinkProps {
  /** The tile's title, on one line. It is shown as text, whatever it holds. */
  title: string;
  /** Where the tile leads. The title is a link to it, in the same tab; omitted, the title is plain text. */
  href?: string;
  /** What hovering the link shows, for example the address it forwards to. */
  hint?: string;
  /** Called when the link is followed, with a click or a middle click, before the browser navigates. It must not delay the navigation. */
  onOpen?: () => void;
  /** The host the tile's icon is drawn for; the favicon of the host, or its monogram when it has none. */
  host: string;
  /** A line in mono under the title, for an address or a host. It is not translated. */
  subtitle?: string;
  /** The rest of the tile, under the subtitle, for example a `SlugChip`. */
  children?: ReactNode;
}

/** One compact card of a `TileGrid` (doc 03 `card-grid` compact variant, quick access tiles): the favicon of the host, the title as the link that stretches over the whole tile, and a mono subtitle. */
export function TileLink({ title, href, hint, onOpen, host, subtitle, children }: TileLinkProps): ReactElement {
  return (
    <li className="min-w-0">
      <Card className="h-full gap-2 p-3 transition-colors focus-within:ring-2 focus-within:ring-ring hover:bg-accent/30">
        <div className="flex items-center gap-3">
          <Favicon host={host} size={32} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-sm">
              {href === undefined ? (
                title
              ) : (
                <a
                  className="rounded-sm outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-2xl"
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
                  title={hint}
                >
                  {title}
                </a>
              )}
            </p>
            {subtitle === undefined ? null : (
              <p className="truncate font-mono text-muted-foreground text-xs" translate="no">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        {children}
      </Card>
    </li>
  );
}
