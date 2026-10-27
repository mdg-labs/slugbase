import type { ReactElement } from "react";
import { Badge } from "../components/ui/badge.tsx";

export interface SlugChipProps {
  /** The slug, shown as the path `/go/<slug>` forwards from. It is drawn as text, whatever it holds. */
  slug: string;
  className?: string;
}

/** A bookmark's slug as a short mono chip (doc 03 `slug-chip`): an outline coss Badge that reads `/go/<slug>`. */
export function SlugChip({ slug, className }: SlugChipProps): ReactElement {
  return (
    <Badge className={className} data-slot="slug-chip" translate="no" variant="outline">
      <span className="font-mono">{`/go/${slug}`}</span>
    </Badge>
  );
}
