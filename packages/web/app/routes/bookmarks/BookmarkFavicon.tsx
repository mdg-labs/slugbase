import { BookmarkGlyph } from "./BookmarkGlyph.js";

type BookmarkFaviconProps = {
  title: string;
  url: string;
  size?: number;
  className?: string;
};

/**
 * List-view bookmark badge — deterministic title monogram (no favicon network fetch).
 * Live favicon proxy remains available for bookmark create/edit metadata flows.
 */
export function BookmarkFavicon({
  title,
  url,
  size = 32,
  className = "",
}: BookmarkFaviconProps) {
  return (
    <BookmarkGlyph title={title} url={url} size={size} className={className} />
  );
}
