import { useTheme } from "@slugbase/ui";
import {
  BookmarkIcon,
  CommandPalette,
  FolderIcon,
  PinIcon,
  PlusIcon,
  SlugChip,
  TagIcon,
  feedbackToast,
  type CommandPaletteHint,
  type CommandPaletteIntent,
  type CommandPaletteItem,
  type CommandPaletteNoResultsAction,
  type CommandPaletteSection,
} from "@slugbase/ui/patterns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { meQuery } from "../account/me.ts";
import { useCachedAccount } from "../account/use-cached-account.ts";
import { useUpdatePreferences } from "../account/use-update-preferences.ts";
import { useSignOut } from "../auth/sign-out.ts";
import { useCanSaveBookmarks } from "../bookmarks/can-save-bookmarks.ts";
import { bookmarkQuery, isHttpUrl, recordOpen, type Bookmark } from "../bookmarks/bookmarks.ts";
import { useBookmarkModal } from "../bookmarks/modal-search.ts";
import { useSwitchFailureMessage, useWorkspaceSwitch, workspacesQuery } from "../shell/workspaces.ts";
import { useCommands, type CommandGroupId, type PaletteContext } from "./commands.ts";
import { paletteBookmarksQuery } from "./palette-bookmarks.ts";
import { createOfferOf, paletteModeOf } from "./palette-query.ts";
import { usePaletteGo } from "./palette-go.tsx";
import { usePaletteSearch, type SearchBookmark } from "./palette-search.ts";
import { usePaletteState } from "./palette-state.tsx";
import { isApplePlatform } from "./platform.ts";

const GROUP_ORDER: readonly CommandGroupId[] = ["navigation", "actions"];

type Page = "root" | "workspaces";

/**
 * The command palette (doc 03 section 9): Recent, Pinned, Navigation and Actions, the last two from the command registry, until
 * something is typed; then the bookmarks, folders and tags the search finds and the commands that match. Choosing a bookmark opens it,
 * Ctrl or Command with Enter opens it in a new tab and Alt with Enter edits one of the member's own. When nothing matches, the palette
 * offers to create a bookmark from what was typed. "Switch workspace" goes on in the palette as a list of the account's workspaces.
 */
export function PaletteDialog(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const api = router.options.context.api;
  const { open, setOpen, focusBack } = usePaletteState();
  const queryClient = useQueryClient();
  const [page, setPageState] = useState<Page>("root");
  const [query, setQuery] = useState("");
  const commands = useCommands();
  const modal = useBookmarkModal();
  const canSaveBookmarks = useCanSaveBookmarks();
  const signOut = useSignOut();
  const updatePreferences = useUpdatePreferences();
  const { resolvedTheme, setTheme } = useTheme();
  const account = useCachedAccount();
  const me = useQuery({ ...meQuery(api), staleTime: Number.POSITIVE_INFINITY });
  const workspaces = useQuery({ ...workspacesQuery(api), enabled: open && page === "workspaces" });
  const { switchTo } = useWorkspaceSwitch();
  const switchFailureMessage = useSwitchFailureMessage();
  const recent = useQuery({ ...paletteBookmarksQuery(api, "recent"), enabled: open });
  const pinned = useQuery({ ...paletteBookmarksQuery(api, "pinned"), enabled: open });

  const mode = page === "root" ? paletteModeOf(query) : { kind: "browse" as const };
  const search = usePaletteSearch(api, mode.kind === "search" ? mode.text : undefined);
  const activeWorkspaceId = me.data?.activeWorkspaceId;
  const workspaceName = me.data?.memberships.find((membership) => membership.workspaceId === activeWorkspaceId)?.name;
  const go = usePaletteGo({
    api,
    slug: mode.kind === "go" ? mode.slug : undefined,
    close: () => {
      close();
    },
    canSaveBookmarks,
    createWithSlug: (slug) => {
      openNewWithSlug(slug);
    },
    workspaceName,
  });

  // The input starts empty on every page and every time the palette opens.
  const setPage = (next: Page): void => {
    setPageState(next);
    setQuery("");
  };

  const close = (): void => {
    go.reset();
    setOpen(false);
    setPage("root");
  };

  const openNewWithSlug = (slug: string): void => {
    // The bookmark modal reads the slug to prefill from the address (doc 02 section 5.2).
    void router.navigate({
      to: ".",
      search: (previous) => ({ ...previous, new: 1 as const, slug, url: undefined, bookmark: undefined }),
    });
  };

  const context: PaletteContext = {
    navigate: (options) => {
      void router.navigate(options);
    },
    openNewBookmark: () => {
      modal.openNew();
    },
    canSaveBookmarks,
    toggleTheme: () => {
      const next = resolvedTheme === "dark" ? "light" : "dark";
      setTheme(next);
      updatePreferences.mutate({ theme: next });
    },
    signOut,
    showWorkspaces: () => {
      setPage("workspaces");
    },
  };

  /** Opens a bookmark's address, here or in a new tab, and counts the open. */
  const openAddress = (id: string, url: string, intent: CommandPaletteIntent): void => {
    if (!isHttpUrl(url)) {
      return;
    }
    recordOpen(api, id);
    close();
    if (intent === "newTab") {
      window.open(url, "_blank", "noopener,noreferrer");
    } else {
      window.location.assign(url);
    }
  };

  const bookmarkItem = (bookmark: Bookmark, pinnedList: boolean): CommandPaletteItem => ({
    id: bookmark.id,
    label: bookmark.title,
    keywords: `${bookmark.host} ${bookmark.slug ?? ""}`,
    icon: pinnedList ? <PinIcon aria-hidden="true" /> : <BookmarkIcon aria-hidden="true" />,
    detail: (
      <span translate="no">
        {bookmark.host}
        {bookmark.slug === null ? "" : ` · /go/${bookmark.slug}`}
      </span>
    ),
    onSelect: (intent) => {
      if (intent === "edit") {
        // Only the owner edits a bookmark; for anyone else Alt with Enter does nothing.
        if (account !== undefined && bookmark.ownerId === account.id) {
          close();
          modal.edit(bookmark.id);
        }
        return;
      }
      openAddress(bookmark.id, bookmark.url, intent);
    },
  });

  // A search result does not say who owns the bookmark, so the bookmark itself is read before Alt with Enter edits it.
  const editIfOwn = (id: string): void => {
    queryClient.query({ ...bookmarkQuery(api, id), retry: false }).then(
      (bookmark) => {
        if (account !== undefined && bookmark.ownerId === account.id) {
          close();
          modal.edit(id);
        }
      },
      () => {
        feedbackToast.error(t("palette.editFailed"));
      },
    );
  };

  const foundBookmarkItem = (bookmark: SearchBookmark): CommandPaletteItem => ({
    id: bookmark.id,
    label: bookmark.title,
    icon: <BookmarkIcon aria-hidden="true" />,
    detail: (
      <span className="flex min-w-0 items-center gap-2">
        {bookmark.slug === null ? null : <SlugChip slug={bookmark.slug} />}
        <span className="truncate" translate="no">
          {bookmark.host}
        </span>
      </span>
    ),
    onSelect: (intent) => {
      if (intent === "edit") {
        editIfOwn(bookmark.id);
        return;
      }
      openAddress(bookmark.id, bookmark.url, intent);
    },
  });

  const bookmarkSection = (id: "recent" | "pinned", result: typeof recent): CommandPaletteSection => {
    const title = t(id === "recent" ? "palette.group.recent" : "palette.group.pinned");
    if (result.data === undefined) {
      return result.isError
        ? { id, title, state: "error", error: { message: t("palette.loadFailed"), retryLabel: t("palette.retry"), onRetry: () => void result.refetch() } }
        : { id, title, state: "loading", loadingLabel: t("palette.loading") };
    }
    return { id, title, items: result.data.map((bookmark) => bookmarkItem(bookmark, id === "pinned")) };
  };

  const commandItems = (groups: readonly CommandGroupId[]): CommandPaletteItem[] =>
    groups.flatMap((group) =>
      commands
        .filter((command) => command.group === group && (command.when?.(context) ?? true))
        .map((command) => ({
          id: command.id,
          label: command.name(t),
          keywords: command.keywords(t),
          icon: command.icon,
          ...(command.shortcut === undefined ? {} : { shortcut: command.shortcut }),
          onSelect: () => {
            if (command.keepOpen !== true) {
              close();
            }
            command.run(context);
          },
        })),
    );

  const commandSections = GROUP_ORDER.map((group): CommandPaletteSection => ({
    id: group,
    title: t(group === "navigation" ? "palette.group.navigation" : "palette.group.actions"),
    items: commandItems([group]),
  }));

  const searchSections = (): CommandPaletteSection[] => {
    const bookmarksTitle = t("palette.group.bookmarks");
    const found: CommandPaletteSection[] =
      search.status === "loading"
        ? [{ id: "bookmarks", title: bookmarksTitle, state: "loading", loadingLabel: t("palette.search.loading") }]
        : search.status === "error"
          ? [{ id: "bookmarks", title: bookmarksTitle, state: "error", error: { message: t("palette.search.failed"), retryLabel: t("palette.retry"), onRetry: search.retry } }]
          : [
              { id: "bookmarks", title: bookmarksTitle, prefiltered: true, items: search.results.bookmarks.map(foundBookmarkItem) },
              {
                id: "folders",
                title: t("palette.group.folders"),
                prefiltered: true,
                items: search.results.folders.map((folder) => ({
                  id: folder.id,
                  label: folder.name,
                  icon: <FolderIcon aria-hidden="true" />,
                  onSelect: (intent: CommandPaletteIntent) => {
                    if (intent !== "edit") {
                      close();
                      context.navigate({ to: "/bookmarks", search: { folderId: folder.id } });
                    }
                  },
                })),
              },
              {
                id: "tags",
                title: t("palette.group.tags"),
                prefiltered: true,
                items: search.results.tags.map((tag) => ({
                  id: tag.id,
                  label: tag.name,
                  icon: <TagIcon aria-hidden="true" />,
                  onSelect: (intent: CommandPaletteIntent) => {
                    if (intent !== "edit") {
                      close();
                      context.navigate({ to: "/bookmarks", search: { tag: [tag.id] } });
                    }
                  },
                })),
              },
            ];
    return [...found, { id: "commands", title: t("palette.group.commands"), items: commandItems(GROUP_ORDER) }];
  };

  let noResultsAction: CommandPaletteNoResultsAction | undefined;
  if (mode.kind === "search" && canSaveBookmarks) {
    const offer = createOfferOf(mode.text);
    noResultsAction = {
      label: offer.kind === "url" ? t("palette.create.url", { url: offer.url }) : offer.kind === "slug" ? t("palette.create.slug", { slug: offer.slug }) : t("palette.create.blank"),
      icon: <PlusIcon aria-hidden="true" />,
      onSelect: () => {
        close();
        if (offer.kind === "slug") {
          openNewWithSlug(offer.slug);
        } else {
          modal.openNew(offer.kind === "url" ? offer.url : undefined);
        }
      },
    };
  }

  let sections: CommandPaletteSection[];
  if (page === "workspaces") {
    const activeId = me.data?.activeWorkspaceId ?? undefined;
    sections = [
      workspaces.data === undefined
        ? workspaces.isError
          ? { id: "workspaces", state: "error", error: { message: t("palette.workspaces.loadFailed"), retryLabel: t("palette.retry"), onRetry: () => void workspaces.refetch() } }
          : { id: "workspaces", state: "loading", loadingLabel: t("palette.workspaces.loading") }
        : {
            id: "workspaces",
            items: workspaces.data.items.map(({ id, name }) => ({
              id,
              label: name,
              ...(id === activeId ? { detail: t("palette.workspaces.current") } : {}),
              onSelect: () => {
                close();
                void switchTo(id).then((outcome) => {
                  if (outcome.status === "failed" && outcome.failure !== undefined) {
                    feedbackToast.error(t("workspaces.switch.failed.title"), switchFailureMessage(outcome.failure));
                  }
                });
              },
            })),
          },
    ];
  } else if (mode.kind === "go") {
    sections = [...go.sections];
  } else if (mode.kind === "search") {
    sections = searchSections();
  } else {
    const bookmarks = [bookmarkSection("recent", recent), bookmarkSection("pinned", pinned)];
    const noneYet = bookmarks.every(({ state, items }) => state === undefined && (items?.length ?? 0) === 0);
    sections = [
      ...(noneYet
        ? [{ id: "bookmarks", state: "empty" as const, notice: { title: t("palette.empty.title"), description: t("palette.empty.description"), icon: <BookmarkIcon aria-hidden="true" /> } }]
        : bookmarks),
      ...commandSections,
    ];
  }

  const apple = isApplePlatform();
  const keys = { enter: "↵", newTab: apple ? "⌘" : t("shortcuts.key.ctrl"), edit: apple ? "⌥" : t("palette.key.alt") };

  const goMode = page === "root" && mode.kind === "go";
  const hints: readonly CommandPaletteHint[] = [
    { id: "navigate", keys: ["↑", "↓"], label: t("palette.hint.navigate") },
    { id: "open", keys: [keys.enter], label: t("palette.hint.open") },
    ...(goMode
      ? []
      : [
          { id: "newTab", keys: [keys.newTab, keys.enter], label: t("palette.hint.newTab") },
          { id: "edit", keys: [keys.edit, keys.enter], label: t("palette.hint.edit") },
        ]),
    { id: "close", keys: [t("shortcuts.key.esc")], label: t("palette.hint.close") },
  ];
  const workspacePage =
    page === "workspaces"
      ? {
          label: t("palette.workspaces.label"),
          onBack: () => {
            setPage("root");
          },
        }
      : undefined;

  return (
    <CommandPalette
      announce={(count) => t("palette.count", { count })}
      closeLabel={t("palette.close")}
      description={t("palette.description")}
      finalFocus={focusBack}
      footerHints={hints}
      inputLabel={t("palette.input")}
      noResults={t("palette.noResults")}
      {...(noResultsAction === undefined ? {} : { noResultsAction })}
      onOpenChange={(next) => {
        if (next) {
          setOpen(true);
        } else {
          close();
        }
      }}
      {...(goMode ? { modeLabel: t("palette.go.mode") } : {})}
      onQueryChange={(next) => {
        go.reset();
        setQuery(next);
      }}
      open={open}
      {...(workspacePage === undefined ? {} : { page: workspacePage })}
      placeholder={t("palette.placeholder")}
      sections={sections}
      title={t("palette.title")}
    />
  );
}
