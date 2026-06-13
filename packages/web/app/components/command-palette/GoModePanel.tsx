import { useTranslation } from "react-i18next";
import { Command } from "cmdk";

import type { SearchBookmarkHit } from "../../lib/search.types.js";
import { goRouteForSlug } from "./go-mode.js";

function GoArrowIcon() {
  return (
    <svg
      aria-hidden
      className="h-[13px] w-[13px] shrink-0 text-fg-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BookmarkGlyph({ title }: { title: string }) {
  const letter = title.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className="inline-grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md bg-raised-2 font-mono text-[11px] font-semibold text-fg-muted"
    >
      {letter}
    </span>
  );
}

export type GoModePanelProps = {
  slugPrefix: string;
  matches: SearchBookmarkHit[];
  loading: boolean;
  onSelectSlug: (slug: string, newTab: boolean) => void;
};

export function GoModePanel({
  slugPrefix,
  matches,
  loading,
  onSelectSlug,
}: GoModePanelProps) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="px-sp-4 py-sp-8 text-center text-[13px] text-fg-subtle">
        {t("command_palette.search_loading")}
      </div>
    );
  }

  const groupHeading =
    slugPrefix.length > 0
      ? t("command_palette.go_mode.group_with_slug", { slug: slugPrefix })
      : t("command_palette.go_mode.group_all_slugs");

  return (
    <Command.Group
      heading={groupHeading}
      className="[&_[cmdk-group-heading]]:px-sp-4 [&_[cmdk-group-heading]]:pb-sp-3 [&_[cmdk-group-heading]]:pt-sp-5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-subtle"
    >
      {matches.length === 0 ? (
        <div className="px-sp-4 py-sp-5 text-center text-[13px] text-fg-subtle">
          {slugPrefix.length > 0
            ? t("command_palette.go_mode.no_match", { slug: slugPrefix })
            : t("command_palette.go_mode.type_to_filter")}
        </div>
      ) : (
        matches.map((bookmark) => {
          const slug = bookmark.slug;
          if (!slug) return null;
          return (
            <Command.Item
              key={bookmark.id}
              value={`go ${slug} ${bookmark.title} ${bookmark.url}`}
              onSelect={() => {
                onSelectSlug(slug, false);
              }}
              className="flex cursor-pointer items-center gap-sp-4 rounded-md px-sp-4 py-[9px] text-fg-muted aria-selected:bg-accent-subtle aria-selected:text-fg data-[selected=true]:bg-accent-subtle data-[selected=true]:text-fg"
              data-testid={`go-mode-item-${slug}`}
            >
              <BookmarkGlyph title={bookmark.title} />
              <span className="shrink-0 font-mono text-[length:var(--text-body-lg)] font-semibold text-fg aria-selected:text-accent-text data-[selected=true]:text-accent-text">
                /go/{slug}
              </span>
              <GoArrowIcon />
              <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-small)] text-fg-subtle">
                {bookmark.url}
              </span>
            </Command.Item>
          );
        })
      )}
    </Command.Group>
  );
}

export function GoModeBadge() {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex shrink-0 items-center gap-[5px] rounded-sm bg-accent-subtle px-[7px] py-[3px] font-mono text-[11px] font-semibold uppercase tracking-wide text-accent-text"
      data-testid="go-mode-badge"
    >
      <svg
        aria-hidden
        className="h-[11px] w-[11px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {t("command_palette.go_mode.badge")}
    </span>
  );
}

/** Resolves the slug for keyboard submit (exact prefix match or first hit). */
export function resolveGoSlugSelection(
  matches: SearchBookmarkHit[],
  slugPrefix: string,
): string | null {
  if (slugPrefix.length > 0) {
    const exact = matches.find(
      (bookmark) => bookmark.slug?.toLowerCase() === slugPrefix,
    );
    if (exact?.slug) return exact.slug;
  }
  return matches[0]?.slug ?? null;
}

export { goRouteForSlug };
