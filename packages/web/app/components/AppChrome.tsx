import { useTranslate } from "@tolgee/react";
import { AppShell, ThemeSwitcher } from "@slugbase/ui";
import { Outlet } from "react-router";

import {
  BookmarkModalProvider,
  useBookmarkModal,
} from "./bookmark-modal/BookmarkModalProvider.js";
import { CommandPalette } from "./command-palette/CommandPalette.js";
import {
  CommandPaletteProvider,
  useCommandPalette,
} from "./command-palette/CommandPaletteProvider.js";

function AppChromeInner() {
  const { t } = useTranslate();
  const { open, setOpen } = useCommandPalette();
  const { openCreate } = useBookmarkModal();

  return (
    <>
      <AppShell
        brandLabel={t("app.shell.brand")}
        workspaceLabel={t("app.shell.workspace_default")}
        headerActions={
          <ThemeSwitcher
            labels={{
              group: t("theme.switcher.group"),
              light: t("theme.switcher.light"),
              dark: t("theme.switcher.dark"),
              auto: t("theme.switcher.auto"),
            }}
          />
        }
      >
        <Outlet />
      </AppShell>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        onNewBookmark={openCreate}
      />
    </>
  );
}

export function AppChrome() {
  return (
    <BookmarkModalProvider>
      <CommandPaletteProvider>
        <AppChromeInner />
      </CommandPaletteProvider>
    </BookmarkModalProvider>
  );
}
