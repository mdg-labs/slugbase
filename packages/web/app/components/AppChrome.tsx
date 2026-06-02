import { useTranslate } from "@tolgee/react";
import { AppShell } from "@slugbase/ui";
import { Outlet, useNavigate } from "react-router";
import { useEffect, useState } from "react";

import { AppSidebar } from "./AppSidebar.js";
import { AppTopBar } from "./AppTopBar.js";
import {
  BookmarkModalProvider,
  useBookmarkModal,
} from "./bookmark-modal/BookmarkModalProvider.js";
import { CommandPalette } from "./command-palette/CommandPalette.js";
import {
  CommandPaletteProvider,
  useCommandPalette,
} from "./command-palette/CommandPaletteProvider.js";
import {
  OnboardingOverlay,
  isOnboardingDone,
  markOnboardingDone,
} from "./onboarding/OnboardingOverlay.js";
import { useAppShellData } from "../lib/session-client.js";

function AppChromeInner() {
  const { t } = useTranslate();
  const navigate = useNavigate();
  const { open, setOpen } = useCommandPalette();
  const { openCreate } = useBookmarkModal();
  const { user, workspace, workspaces, sidebarFolders, bookmarkTotal } =
    useAppShellData();

  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    if (!isOnboardingDone()) {
      setShowOnboarding(true);
    }
  }, []);

  const themeLabels = {
    group: t("theme.switcher.group"),
    light: t("theme.switcher.light"),
    dark: t("theme.switcher.dark"),
    auto: t("theme.switcher.auto"),
  };

  return (
    <>
      <AppShell
        sidebar={
          <AppSidebar
            workspace={workspace}
            workspaces={workspaces}
            folders={sidebarFolders}
            bookmarkTotal={bookmarkTotal}
            bookmarksUsed={bookmarkTotal}
            onUpgrade={() => { void navigate("/settings/billing"); }}
          />
        }
        topBar={
          <AppTopBar
            userName={user.name}
            userEmail={user.email}
            onOpenPalette={() => { setOpen(true); }}
            onNewBookmark={openCreate}
            themeLabels={themeLabels}
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
      {showOnboarding && (
        <OnboardingOverlay
          workspaceName={workspace.name}
          onDone={() => {
            markOnboardingDone();
            setShowOnboarding(false);
          }}
        />
      )}
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
