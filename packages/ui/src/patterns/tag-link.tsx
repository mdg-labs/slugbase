import type { ReactElement } from "react";
import { Badge } from "../components/ui/badge.tsx";

export interface TagLinkProps {
  /** The tag's name. It is drawn as text, whatever it holds. */
  name: string;
  /** How many bookmarks carry the tag, already formatted for the language. */
  count: string;
  /** The link to render, for example `<Link to="/bookmarks" />`; the pattern sets its class and its content. */
  link: ReactElement;
  className?: string;
}

/** A tag as a badge link with its bookmark count (doc 03 section 2, tag chips): a coss Badge rendered as the given link. */
export function TagLink({ name, count, link, className }: TagLinkProps): ReactElement {
  return (
    <Badge className={className} data-slot="tag-link" render={link} size="lg" variant="outline">
      <span className="max-w-40 truncate" translate="no">
        {name}
      </span>{" "}
      <span className="text-muted-foreground tabular-nums">{count}</span>
    </Badge>
  );
}
