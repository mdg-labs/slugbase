import { ArrowLeftRightIcon, BookmarkIcon, FolderIcon, FolderPlusIcon, ForwardIcon, HomeIcon, LogOutIcon, PlusIcon, SettingsIcon, SunMoonIcon, TagIcon } from "@slugbase/ui/patterns";
import { registerCommand, type PaletteCommand } from "./commands.ts";

/**
 * The commands every palette has (doc 02 section 9.2): the pages of the app and the actions that need no page of their own.
 * Import and Export join the actions when the import and export pages exist.
 */
export const DEFAULT_COMMANDS: readonly PaletteCommand[] = [
  {
    id: "navigate.home",
    group: "navigation",
    order: 10,
    name: (t) => t("palette.command.home.name"),
    keywords: (t) => t("palette.command.home.keywords"),
    icon: <HomeIcon aria-hidden="true" />,
    shortcut: ["G", "H"],
    run: ({ navigate }) => {
      navigate({ to: "/" });
    },
  },
  {
    id: "navigate.bookmarks",
    group: "navigation",
    order: 20,
    name: (t) => t("palette.command.bookmarks.name"),
    keywords: (t) => t("palette.command.bookmarks.keywords"),
    icon: <BookmarkIcon aria-hidden="true" />,
    shortcut: ["G", "B"],
    run: ({ navigate }) => {
      navigate({ to: "/bookmarks" });
    },
  },
  {
    id: "navigate.folders",
    group: "navigation",
    order: 30,
    name: (t) => t("palette.command.folders.name"),
    keywords: (t) => t("palette.command.folders.keywords"),
    icon: <FolderIcon aria-hidden="true" />,
    shortcut: ["G", "F"],
    run: ({ navigate }) => {
      navigate({ to: "/folders" });
    },
  },
  {
    id: "navigate.tags",
    group: "navigation",
    order: 40,
    name: (t) => t("palette.command.tags.name"),
    keywords: (t) => t("palette.command.tags.keywords"),
    icon: <TagIcon aria-hidden="true" />,
    shortcut: ["G", "T"],
    run: ({ navigate }) => {
      navigate({ to: "/tags" });
    },
  },
  {
    id: "navigate.forwarding",
    group: "navigation",
    order: 50,
    name: (t) => t("palette.command.forwarding.name"),
    keywords: (t) => t("palette.command.forwarding.keywords"),
    icon: <ForwardIcon aria-hidden="true" />,
    shortcut: ["G", "W"],
    run: ({ navigate }) => {
      navigate({ to: "/forwarding" });
    },
  },
  {
    id: "navigate.settings",
    group: "navigation",
    order: 60,
    name: (t) => t("palette.command.settings.name"),
    keywords: (t) => t("palette.command.settings.keywords"),
    icon: <SettingsIcon aria-hidden="true" />,
    run: ({ navigate }) => {
      navigate({ to: "/settings/account" });
    },
  },
  {
    id: "action.new-bookmark",
    group: "actions",
    order: 10,
    name: (t) => t("palette.command.newBookmark.name"),
    keywords: (t) => t("palette.command.newBookmark.keywords"),
    icon: <PlusIcon aria-hidden="true" />,
    shortcut: ["C"],
    when: ({ canSaveBookmarks }) => canSaveBookmarks,
    run: ({ openNewBookmark }) => {
      openNewBookmark();
    },
  },
  {
    id: "action.new-folder",
    group: "actions",
    order: 20,
    name: (t) => t("palette.command.newFolder.name"),
    keywords: (t) => t("palette.command.newFolder.keywords"),
    icon: <FolderPlusIcon aria-hidden="true" />,
    run: ({ navigate }) => {
      navigate({ to: "/folders", search: { create: 1 } });
    },
  },
  {
    id: "action.switch-workspace",
    group: "actions",
    order: 30,
    name: (t) => t("palette.command.switchWorkspace.name"),
    keywords: (t) => t("palette.command.switchWorkspace.keywords"),
    icon: <ArrowLeftRightIcon aria-hidden="true" />,
    keepOpen: true,
    run: ({ showWorkspaces }) => {
      showWorkspaces();
    },
  },
  {
    id: "action.toggle-theme",
    group: "actions",
    order: 40,
    name: (t) => t("palette.command.toggleTheme.name"),
    keywords: (t) => t("palette.command.toggleTheme.keywords"),
    icon: <SunMoonIcon aria-hidden="true" />,
    run: ({ toggleTheme }) => {
      toggleTheme();
    },
  },
  {
    id: "action.sign-out",
    group: "actions",
    order: 50,
    name: (t) => t("palette.command.signOut.name"),
    keywords: (t) => t("palette.command.signOut.keywords"),
    icon: <LogOutIcon aria-hidden="true" />,
    run: ({ signOut }) => {
      signOut();
    },
  },
];

/** Registers the default commands and returns the function that takes them all away again. */
export function registerDefaultCommands(): () => void {
  const removals = DEFAULT_COMMANDS.map((command) => registerCommand(command));
  return () => {
    for (const remove of removals) {
      remove();
    }
  };
}
