import { useTheme } from "@slugbase/ui";
import { BookmarkIcon, CommandPalette, PinIcon, feedbackToast, type CommandPaletteHint, type CommandPaletteItem, type CommandPaletteSection } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { meQuery } from "../account/me.ts";
import { useCachedAccount } from "../account/use-cached-account.ts";
import { useUpdatePreferences } from "../account/use-update-preferences.ts";
import { useSignOut } from "../auth/sign-out.ts";
import { useCanSaveBookmarks } from "../bookmarks/can-save-bookmarks.ts";
import { isHttpUrl, recordOpen, type Bookmark } from "../bookmarks/bookmarks.ts";
import { useBookmarkModal } from "../bookmarks/modal-search.ts";
import { useSwitchFailureMessage, useWorkspaceSwitch, workspacesQuery } from "../shell/workspaces.ts";
import { useCommands, type CommandGroupId, type PaletteContext } from "./commands.ts";
import { paletteBookmarksQuery } from "./palette-bookmarks.ts";
import { usePaletteState } from "./palette-state.tsx";
import { isApplePlatform } from "./platform.ts";

const GROUP_ORDER: readonly CommandGroupId[] = ["navigation", "actions"];

type Page = "root" | "workspaces";

/**
 * The command palette (doc 03 section 9): Recent, Pinned, Navigation and Actions, the last two from the command registry.
 * Choosing a bookmark opens it, Ctrl or Command with Enter opens it in a new tab and Alt with Enter edits one of the member's own.
 * "Switch workspace" goes on in the palette as a list of the account's workspaces.
 */
export function PaletteDialog(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const api = router.options.context.api;
  const { open, setOpen, focusBack } = usePaletteState();
  const [page, setPage] = useState<Page>("root");
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

  const close = (): void => {
    setOpen(false);
    setPage("root");
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
      if (!isHttpUrl(bookmark.url)) {
        return;
      }
      recordOpen(api, bookmark.id);
      close();
      if (intent === "newTab") {
        window.open(bookmark.url, "_blank", "noopener,noreferrer");
      } else {
        window.location.assign(bookmark.url);
      }
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

  const commandSections = GROUP_ORDER.map((group): CommandPaletteSection => ({
    id: group,
    title: t(group === "navigation" ? "palette.group.navigation" : "palette.group.actions"),
    items: commands
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
  }));

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

  const hints: readonly CommandPaletteHint[] = [
    { id: "navigate", keys: ["↑", "↓"], label: t("palette.hint.navigate") },
    { id: "open", keys: [keys.enter], label: t("palette.hint.open") },
    { id: "newTab", keys: [keys.newTab, keys.enter], label: t("palette.hint.newTab") },
    { id: "edit", keys: [keys.edit, keys.enter], label: t("palette.hint.edit") },
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
      onOpenChange={(next) => {
        if (next) {
          setOpen(true);
        } else {
          close();
        }
      }}
      open={open}
      {...(workspacePage === undefined ? {} : { page: workspacePage })}
      placeholder={t("palette.placeholder")}
      sections={sections}
      title={t("palette.title")}
    />
  );
}
