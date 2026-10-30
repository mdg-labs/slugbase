import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@slugbase/ui";
import { AccountMenu, AppShell, BookmarkIcon, FolderIcon, ForwardIcon, HomeIcon, LifeBuoyIcon, LockIcon, LogOutIcon, SettingsIcon, ShieldCheckIcon, TagIcon, ThemeToggle } from "@slugbase/ui/patterns";
import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AccountPreferences } from "../account/account-preferences.tsx";
import { useCachedAccount } from "../account/use-cached-account.ts";
import { useUpdatePreferences } from "../account/use-update-preferences.ts";
import { BookmarkModal } from "../bookmarks/bookmark-modal.tsx";
import { validateBookmarkListSearch } from "../bookmarks/list-search.ts";
import { NewBookmarkButton } from "../bookmarks/new-bookmark-button.tsx";
import { useSignOut } from "../auth/sign-out.ts";
import { useConfig } from "../config/config-context.tsx";
import { Slot, useExtensions } from "../extensions/index.ts";
import { useAllFolders, useSharedFolders } from "../folders/use-all-folders.ts";
import { PaletteDialog } from "../palette/palette-dialog.tsx";
import { PaletteProvider } from "../palette/palette-state.tsx";
import { PaletteTrigger } from "../palette/palette-trigger.tsx";
import { AppShortcuts } from "../shortcuts/app-shortcuts.tsx";
import { docsUrl } from "./docs-url.ts";
import { EmailUnverifiedBanner, MailNotConfiguredBanner } from "./banners.tsx";
import { OfflineBanner } from "./offline-banner.tsx";
import { SidebarFolders } from "./sidebar-folders.tsx";
import { useWorkspaceSwitcher } from "./workspace-switcher.tsx";

function AppLayoutShell(): ReactElement {
  const { t } = useTranslation();
  const { product, docsBaseUrl } = useConfig();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const search = useRouterState({ select: (state) => state.location.search });
  const extensions = useExtensions();
  const signOut = useSignOut();
  const router = useRouter();
  const updatePreferences = useUpdatePreferences();
  const { switcher, dialog } = useWorkspaceSwitcher();
  const account = useCachedAccount();
  const inBookmarks = pathname === "/bookmarks" || pathname.startsWith("/bookmarks/");
  const folders = useAllFolders();
  const sharedFolders = useSharedFolders();
  // The folder the bookmarks list is filtered by, when it is one of the member's or one shared with them: it is the current item of the sidebar and the last crumb.
  const filterFolderId = pathname === "/bookmarks" ? validateBookmarkListSearch(search).folderId : undefined;
  const filterFolder = [...folders.folders, ...sharedFolders.folders].find((folder) => folder.id === filterFolderId);
  const inFolders = pathname === "/folders" || pathname.startsWith("/folders/");
  const inTags = pathname === "/tags" || pathname.startsWith("/tags/");
  const inForwarding = pathname === "/forwarding" || pathname.startsWith("/forwarding/");
  const inSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const inAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  const accountItems = [
    {
      id: "settings",
      label: t("shell.accountSettings"),
      icon: <SettingsIcon aria-hidden="true" />,
      onSelect: () => {
        void router.navigate({ to: "/settings/account" });
      },
    },
    {
      id: "security",
      label: t("shell.security"),
      icon: <LockIcon aria-hidden="true" />,
      onSelect: () => {
        void router.navigate({ to: "/settings/account/security" });
      },
    },
    { id: "sign-out", label: t("shell.signOut"), icon: <LogOutIcon aria-hidden="true" />, onSelect: signOut },
  ];

  return (
    <AppShell
      actions={
        <>
          <PaletteTrigger />
          <NewBookmarkButton />
          <ThemeToggle
            onToggle={(theme) => {
              updatePreferences.mutate({ theme });
            }}
            switchToDark={t("shell.switchToDark")}
            switchToLight={t("shell.switchToLight")}
          />
          <AccountMenu
            items={accountItems}
            label={t("shell.account")}
          />
        </>
      }
      breadcrumb={
        <Breadcrumb aria-label={t("shell.breadcrumb")}>
          <BreadcrumbList>
            {inBookmarks && filterFolder !== undefined ? (
              <>
                <BreadcrumbItem>
                  <BreadcrumbLink render={<Link to="/bookmarks" />}>{t("shell.bookmarks")}</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{filterFolder.name}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : (
              <BreadcrumbItem>
                <BreadcrumbPage>{inAdmin ? t("shell.admin") : inSettings ? t("shell.settings") : inBookmarks ? t("shell.bookmarks") : inFolders ? t("shell.folders") : inTags ? t("shell.tags") : inForwarding ? t("shell.forwarding") : t("shell.home")}</BreadcrumbPage>
              </BreadcrumbItem>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      }
      footer={
        <>
          <Slot name="sidebar.footer" />
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<a href={docsUrl(docsBaseUrl)} rel="noreferrer" target="_blank" />}
                tooltip={t("shell.helpAndDocs")}
              >
                <LifeBuoyIcon aria-hidden="true" />
                <span>{t("shell.helpAndDocs")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </>
      }
      labels={{
        skipToContent: t("shell.skipToContent"),
        toggleSidebar: t("shell.toggleSidebar"),
        navigation: t("shell.navigation"),
        drawerTitle: t("shell.drawerTitle"),
        drawerDescription: t("shell.drawerDescription"),
        drawerClose: t("shell.drawerClose"),
      }}
      navigation={
        <>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={pathname === "/"} render={<Link to="/" />} tooltip={t("shell.home")}>
                <HomeIcon aria-hidden="true" />
                <span>{t("shell.home")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={inBookmarks && filterFolder === undefined} render={<Link to="/bookmarks" />} tooltip={t("shell.bookmarks")}>
                <BookmarkIcon aria-hidden="true" />
                <span>{t("shell.bookmarks")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={inFolders} render={<Link to="/folders" />} tooltip={t("shell.folders")}>
                <FolderIcon aria-hidden="true" />
                <span>{t("shell.folders")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={inTags} render={<Link to="/tags" />} tooltip={t("shell.tags")}>
                <TagIcon aria-hidden="true" />
                <span>{t("shell.tags")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={inForwarding} render={<Link to="/forwarding" />} tooltip={t("shell.forwarding")}>
                <ForwardIcon aria-hidden="true" />
                <span>{t("shell.forwarding")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {account?.isInstanceAdmin === true ? (
              <SidebarMenuItem>
                <SidebarMenuButton isActive={inAdmin} render={<Link to="/admin" />} tooltip={t("shell.admin")}>
                  <ShieldCheckIcon aria-hidden="true" />
                  <span>{t("shell.admin")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
            {extensions.flatMap(({ id, navigation = [] }) =>
              navigation.map(({ to, label, icon }) => (
                <SidebarMenuItem key={`${id}:${to}`}>
                  <SidebarMenuButton isActive={pathname === to || pathname.startsWith(`${to}/`)} render={<Link to={to} />} tooltip={label}>
                    {icon}
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )),
            )}
          </SidebarMenu>
          <SidebarFolders activeId={filterFolder?.id} folders={folders} shared={sharedFolders} />
        </>
      }
      productName={product.name}
      workspaceSwitcher={switcher}
    >
      {dialog}
      <BookmarkModal />
      <AppShortcuts />
      <PaletteDialog />
      <OfflineBanner />
      <EmailUnverifiedBanner />
      <MailNotConfiguredBanner />
      <Slot name="banner.entitlement" />
      <Outlet />
    </AppShell>
  );
}

/**
 * The in-app layout route: the app shell around the page of the current route, under the account's
 * preferences. The sidebar lists the routes that exist; each page adds its own as it arrives.
 */
export function AppLayout(): ReactElement {
  return (
    <AccountPreferences>
      <PaletteProvider>
        <AppLayoutShell />
      </PaletteProvider>
    </AccountPreferences>
  );
}
