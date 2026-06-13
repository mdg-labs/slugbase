import { Kbd } from "@slugbase/ui";
import { useTranslation } from "react-i18next";
import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";

import type { GlobalSearchResult } from "../../lib/search.types.js";
import {
  GO_SLUG_MATCH_LIMIT,
  filterGoSlugMatches,
  goRouteForSlug,
  openGoTarget,
  parsePaletteQuery,
} from "./go-mode.js";
import { GoModeBadge, GoModePanel, resolveGoSlugSelection } from "./GoModePanel.js";
import {
  PALETTE_ACTION_GROUPS,
  PALETTE_ACTIONS,
  PALETTE_SHORTCUTS,
  type PaletteActionDef,
  type PaletteActionId,
} from "./palette-actions.js";
import { BookmarkGlyph } from "../../routes/bookmarks/BookmarkGlyph.js";
import { useDebouncedValue } from "./use-debounced-value.js";

const SEARCH_PREVIEW_LIMIT = 3;
const SEARCH_DEBOUNCE_MS = 200;

function SearchIcon() {
  return (
    <svg
      aria-hidden
      className="h-[18px] w-[18px] shrink-0 text-accent-text"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}

function CornerDownLeftIcon() {
  return (
    <svg
      aria-hidden
      className="h-[13px] w-[13px] shrink-0 text-fg-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 01-4 4H4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ActionIcon({ path }: { path: string }) {
  return (
    <svg
      aria-hidden
      className="h-[15px] w-[15px] shrink-0 text-fg-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d={path} />
    </svg>
  );
}

function FolderGlyph({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      className="inline-grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md"
      style={{ background: color ?? "var(--accent-subtle)" }}
    >
      <svg
        className="h-[13px] w-[13px] text-[color:var(--accent-fg)]"
        fill="currentColor"
        viewBox="0 0 24 24"
      >
        <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" />
      </svg>
    </span>
  );
}

function SlugBaseIcon() {
  return (
    <svg
      aria-hidden
      className="h-[16px] w-[16px] shrink-0 text-fg-faint"
      viewBox="0 0 32 32"
      fill="currentColor"
    >
      <rect width="32" height="32" rx="8" fill="currentColor" opacity="0.15" />
      <path d="M8 11.5C8 9.567 9.567 8 11.5 8H20.5C22.433 8 24 9.567 24 11.5V14C24 14.552 23.552 15 23 15H9C8.448 15 8 14.552 8 14V11.5Z" />
      <path d="M8 18C8 17.448 8.448 17 9 17H23C23.552 17 24 17.448 24 18V20.5C24 22.433 22.433 24 20.5 24H11.5C9.567 24 8 22.433 8 20.5V18Z" />
      <rect x="13" y="13.5" width="6" height="5" rx="1" />
    </svg>
  );
}

export type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewBookmark?: () => void;
};

export function CommandPalette({
  open,
  onOpenChange,
  onNewBookmark,
}: CommandPaletteProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fetcher = useFetcher<GlobalSearchResult>();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const enterOpensNewTabRef = useRef(false);

  const parsedQuery = useMemo(() => parsePaletteQuery(query), [query]);
  const isGoMode = parsedQuery.mode === "go";
  const isSearchMode =
    parsedQuery.mode === "search" && debouncedQuery.length > 0;
  const goSlugPrefix = parsedQuery.slugPrefix;

  const searchResult =
    fetcher.state === "idle" && fetcher.data && "q" in fetcher.data
      ? fetcher.data
      : null;

  const goSlugMatches = useMemo(() => {
    if (!isGoMode || !searchResult) return [];
    return filterGoSlugMatches(
      searchResult.bookmarks.items,
      goSlugPrefix,
      GO_SLUG_MATCH_LIMIT,
    );
  }, [goSlugPrefix, isGoMode, searchResult]);

  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  useEffect(() => {
    if (!isGoMode) return;
    if (goSlugPrefix.length === 0) return;

    const params = new URLSearchParams({
      q: goSlugPrefix,
      bookmarkLimit: String(GO_SLUG_MATCH_LIMIT),
      folderLimit: "1",
      tagLimit: "1",
    });
    void fetcher.load(`/api/search?${params.toString()}`);
  }, [goSlugPrefix, isGoMode]);

  useEffect(() => {
    if (!isSearchMode) return;
    const params = new URLSearchParams({
      q: debouncedQuery,
      bookmarkLimit: String(SEARCH_PREVIEW_LIMIT),
      folderLimit: String(SEARCH_PREVIEW_LIMIT),
      tagLimit: String(SEARCH_PREVIEW_LIMIT),
    });
    void fetcher.load(`/api/search?${params.toString()}`);
  }, [debouncedQuery, isSearchMode]);

  const runAction = useCallback(
    (action: PaletteActionDef) => {
      if (action.id === "new-bookmark" && onNewBookmark) {
        onNewBookmark();
        onOpenChange(false);
        return;
      }
      if (action.path) {
        void navigate(action.path);
      }
      onOpenChange(false);
    },
    [navigate, onNewBookmark, onOpenChange],
  );

  const runActionById = useCallback(
    (id: PaletteActionId) => {
      const action = PALETTE_ACTIONS.find((item) => item.id === id);
      if (action) runAction(action);
    },
    [runAction],
  );

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      enterOpensNewTabRef.current = true;
    }

    if (isGoMode && event.key === "Enter" && !event.altKey) {
      const slug = resolveGoSlugSelection(goSlugMatches, goSlugPrefix);
      if (slug) {
        event.preventDefault();
        openGoTarget(goRouteForSlug(slug), enterOpensNewTabRef.current);
        enterOpensNewTabRef.current = false;
        onOpenChange(false);
        return;
      }
    }

    if (query.trim()) return;

    const key = event.key.toLowerCase();
    const shortcutId = PALETTE_SHORTCUTS[key];
    if (shortcutId && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      runActionById(shortcutId);
      return;
    }

    if (event.altKey && key === "w") {
      event.preventDefault();
      runActionById("switch-workspace");
    }
  };

  const bookmarkHits = searchResult?.bookmarks.items ?? [];
  const folderHits = searchResult?.folders.items ?? [];
  const tagHits = searchResult?.tags.items ?? [];
  const hasSearchResults =
    bookmarkHits.length > 0 || folderHits.length > 0 || tagHits.length > 0;
  const showNoResults =
    isSearchMode &&
    fetcher.state === "idle" &&
    searchResult !== null &&
    !hasSearchResults;

  const seeAllBookmarks =
    isSearchMode &&
    searchResult &&
    (searchResult.bookmarks.truncated ||
      searchResult.bookmarks.total > SEARCH_PREVIEW_LIMIT)
      ? {
          q: searchResult.q,
          total: searchResult.bookmarks.total,
          fallback: searchResult.fallback.bookmarks,
        }
      : null;

  const openBookmark = useCallback(
    (url: string, newTab: boolean) => {
      if (newTab) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        window.location.assign(url);
      }
      onOpenChange(false);
    },
    [onOpenChange],
  );

  const actionsByGroup = useMemo(() => {
    const map = new Map<string, PaletteActionDef[]>();
    for (const groupKey of PALETTE_ACTION_GROUPS) {
      map.set(
        groupKey,
        PALETTE_ACTIONS.filter((action) => action.groupKey === groupKey),
      );
    }
    return map;
  }, []);

  const goLoading = isGoMode && goSlugPrefix.length > 0 && fetcher.state === "loading";

  const GROUP_HEADING_CLS =
    "[&_[cmdk-group-heading]]:px-sp-4 [&_[cmdk-group-heading]]:pb-sp-3 [&_[cmdk-group-heading]]:pt-sp-5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-subtle";
  const ITEM_CLS =
    "group flex cursor-pointer items-center gap-sp-4 rounded-md px-sp-4 py-[9px] text-fg-muted aria-selected:bg-accent-subtle aria-selected:text-fg data-[selected=true]:bg-accent-subtle data-[selected=true]:text-fg";

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label={t("command_palette.dialog_label")}
      overlayClassName="fixed inset-0 z-[100] flex items-center justify-center bg-[color:var(--overlay-scrim)] px-sp-4 pb-sp-8 backdrop-blur-[3px]"
      contentClassName="palette-panel w-full max-w-[640px] overflow-hidden rounded-xl border border-[color:var(--border-strong)] bg-overlay p-0 shadow-overlay"
    >
      <div
        data-testid="command-palette-dialog"
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="flex items-center gap-sp-4 border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-5">
          {isGoMode ? <GoModeBadge /> : <SearchIcon />}
          <Command.Input
            value={query}
            onValueChange={setQuery}
            onKeyDown={handleInputKeyDown}
            placeholder={
              isGoMode
                ? t("command_palette.go_mode.input_placeholder")
                : t("command_palette.input_placeholder")
            }
            className="flex-1 bg-transparent text-[length:var(--text-h3)] font-normal text-fg outline-none placeholder:text-fg-faint"
            data-testid="command-palette-input"
          />
          {query ? (
            <button
              type="button"
              aria-label={t("command_palette.clear_query")}
              className="inline-grid place-items-center text-fg-faint hover:text-fg-muted"
              onClick={() => {
                setQuery("");
              }}
            >
              <svg
                aria-hidden
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          ) : (
            <Kbd>{t("ui.kbd.escape")}</Kbd>
          )}
        </div>

        <Command.List className="max-h-[46vh] overflow-y-auto p-sp-3">
            {parsedQuery.mode === "default" &&
              PALETTE_ACTION_GROUPS.map((groupKey) => {
                const actions = actionsByGroup.get(groupKey) ?? [];
                if (actions.length === 0) return null;

                return (
                  <Command.Group
                    key={groupKey}
                    heading={t(groupKey)}
                    className={GROUP_HEADING_CLS}
                  >
                    {actions.map((action) => (
                      <Command.Item
                        key={action.id}
                        value={`${t(action.titleKey)} ${action.id}`}
                        onSelect={() => {
                          runAction(action);
                        }}
                        className={ITEM_CLS}
                      >
                        {action.iconPath ? (
                          <ActionIcon path={action.iconPath} />
                        ) : null}
                        <span className="flex-1 text-[length:var(--text-body-lg)]">
                          {t(action.titleKey)}
                        </span>
                        {action.hint ? <Kbd>{action.hint}</Kbd> : null}
                        <CornerDownLeftIcon />
                      </Command.Item>
                    ))}
                  </Command.Group>
                );
              })}

            {isGoMode ? (
              <GoModePanel
                slugPrefix={goSlugPrefix}
                matches={goSlugMatches}
                loading={goLoading}
                onSelectSlug={(slug, newTab) => {
                  openGoTarget(
                    goRouteForSlug(slug),
                    newTab || enterOpensNewTabRef.current,
                  );
                  enterOpensNewTabRef.current = false;
                  onOpenChange(false);
                }}
              />
            ) : null}

            {isSearchMode && fetcher.state === "loading" && (
              <div className="px-sp-4 py-sp-8 text-center text-[13px] text-fg-subtle">
                {t("command_palette.search_loading")}
              </div>
            )}

            {showNoResults && (
              <div className="px-sp-4 py-sp-8 text-center text-[13px] text-fg-subtle">
                {t("command_palette.no_results", { query: debouncedQuery })}
                <div className="mt-sp-4 text-[12px] text-fg-faint">
                  {t("command_palette.no_results_hint")}
                </div>
              </div>
            )}

            {isSearchMode && hasSearchResults && bookmarkHits.length > 0 && (
              <Command.Group
                heading={t("command_palette.group.bookmarks")}
                className={GROUP_HEADING_CLS}
              >
                {bookmarkHits.map((bookmark) => (
                  <Command.Item
                    key={bookmark.id}
                    value={`bookmark ${bookmark.title} ${bookmark.url} ${bookmark.slug ?? ""}`}
                    onSelect={() => {
                      openBookmark(bookmark.url, false);
                    }}
                    className={ITEM_CLS}
                  >
                    <BookmarkGlyph title={bookmark.title} url={bookmark.url} size={22} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--text-body-lg)]">
                        {bookmark.title}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-fg-faint">
                        {bookmark.url}
                      </span>
                    </span>
                    {bookmark.slug ? (
                      <span className="font-mono text-[length:var(--text-small)] text-fg-subtle">
                        /go/{bookmark.slug}
                      </span>
                    ) : null}
                    <CornerDownLeftIcon />
                  </Command.Item>
                ))}
                {seeAllBookmarks ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-sp-3 rounded-sm px-sp-4 py-[6px] text-left text-[length:var(--text-small)] font-medium text-accent-text hover:bg-raised"
                    onClick={() => {
                      const { path, queryParam } = seeAllBookmarks.fallback;
                      void navigate(
                        `${path}?${queryParam}=${encodeURIComponent(seeAllBookmarks.q)}`,
                      );
                      onOpenChange(false);
                    }}
                  >
                    {t("command_palette.see_all_bookmarks", {
                      count: seeAllBookmarks.total,
                      query: seeAllBookmarks.q,
                    })}
                  </button>
                ) : null}
              </Command.Group>
            )}

            {isSearchMode && hasSearchResults && folderHits.length > 0 && (
              <Command.Group
                heading={t("command_palette.group.folders")}
                className={GROUP_HEADING_CLS}
              >
                {folderHits.map((folder) => (
                  <Command.Item
                    key={folder.id}
                    value={`folder ${folder.name}`}
                    onSelect={() => {
                      void navigate(`/folders/${folder.id}`);
                      onOpenChange(false);
                    }}
                    className={ITEM_CLS}
                  >
                    <FolderGlyph color={folder.icon} />
                    <span className="flex-1 text-[length:var(--text-body-lg)]">
                      {folder.name}
                    </span>
                    <span className="text-[length:var(--text-small)] text-fg-subtle">
                      {t("command_palette.bookmark_count", {
                        count: folder.bookmarkCount,
                      })}
                    </span>
                    <CornerDownLeftIcon />
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {isSearchMode && hasSearchResults && tagHits.length > 0 && (
              <Command.Group
                heading={t("command_palette.group.tags")}
                className={GROUP_HEADING_CLS}
              >
                {tagHits.map((tag) => (
                  <Command.Item
                    key={tag.id}
                    value={`tag ${tag.name}`}
                    onSelect={() => {
                      void navigate(`/tags/${encodeURIComponent(tag.name)}`);
                      onOpenChange(false);
                    }}
                    className={ITEM_CLS}
                  >
                    <span className="font-mono text-[length:var(--text-body-lg)]">
                      #{tag.name}
                    </span>
                    <span className="text-[length:var(--text-small)] text-fg-subtle">
                      {t("command_palette.bookmark_count", {
                        count: tag.bookmarkCount,
                      })}
                    </span>
                    <CornerDownLeftIcon />
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>

        <div className="flex flex-wrap items-center gap-sp-6 border-t border-[color:var(--border-subtle)] px-sp-6 py-sp-4 text-[length:var(--text-micro)] text-fg-subtle">
          <span className="inline-flex items-center gap-[5px]">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t("command_palette.footer.navigate")}
          </span>
          <span className="inline-flex items-center gap-[5px]">
            <Kbd>↵</Kbd>
            {t("command_palette.footer.select")}
          </span>
          {isGoMode ? (
            <>
              <span className="inline-flex items-center gap-[5px]">
                <Kbd>↵</Kbd>
                {t("command_palette.go_mode.footer_redirect")}
              </span>
              <span className="inline-flex items-center gap-[5px]">
                <Kbd>⌘</Kbd>
                <Kbd>↵</Kbd>
                {t("command_palette.footer.open_new_tab")}
              </span>
            </>
          ) : null}
          {isSearchMode ? (
            <span className="inline-flex items-center gap-[5px]">
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
              {t("command_palette.footer.open_new_tab")}
            </span>
          ) : null}
          <span className="ml-auto inline-flex items-center gap-[5px]">
            <Kbd>esc</Kbd>
            {t("command_palette.footer.close")}
          </span>
          <span className="inline-flex items-center gap-sp-2">
            <SlugBaseIcon />
            {t("app.shell.brand")}
          </span>
        </div>
      </div>
    </Command.Dialog>
  );
}
