import {
  bookmarkGlyphBorderRadius,
  bookmarkGlyphFontSize,
  getBookmarkGlyphColor,
  getBookmarkMonogramInitials,
} from "./bookmark-glyph.js";

export type BookmarkGlyphProps = {
  title: string;
  url: string;
  size?: number;
  className?: string;
};

/**
 * Deterministic title monogram badge with hostname-hashed accent color.
 * Used on list views, dashboard widgets, and the command palette — no live favicon fetch.
 */
export function BookmarkGlyph({
  title,
  url,
  size = 32,
  className = "",
}: BookmarkGlyphProps) {
  const initials = getBookmarkMonogramInitials(title);
  const background = getBookmarkGlyphColor(url);

  return (
    <span
      className={[
        "inline-flex shrink-0 items-center justify-center font-mono font-semibold text-white",
        className,
      ].join(" ")}
      style={{
        width: size,
        height: size,
        fontSize: bookmarkGlyphFontSize(size, initials),
        borderRadius: bookmarkGlyphBorderRadius(size),
        background,
      }}
      aria-hidden
    >
      {initials}
    </span>
  );
}
