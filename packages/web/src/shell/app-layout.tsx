import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@slugbase/ui";
import { AccountMenu, AppShell, HomeIcon, LifeBuoyIcon, LogOutIcon, SettingsIcon, ThemeToggle } from "@slugbase/ui/patterns";
import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useSignOut } from "../auth/sign-out.ts";
import { useConfig } from "../config/config-context.tsx";
import { Slot, useExtensions } from "../extensions/index.ts";
import { docsUrl } from "./docs-url.ts";
import { OfflineBanner } from "./offline-banner.tsx";

/**
 * The in-app layout route: the app shell around the page of the current route.
 * The sidebar lists the routes that exist; each page adds its own as it arrives.
 */
export function AppLayout(): ReactElement {
  const { t } = useTranslation();
  const { product, docsBaseUrl } = useConfig();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const extensions = useExtensions();
  const signOut = useSignOut();
  const router = useRouter();
  const inSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const accountItems = [
    {
      id: "settings",
      label: t("shell.accountSettings"),
      icon: <SettingsIcon aria-hidden="true" />,
      onSelect: () => {
        void router.navigate({ to: "/settings/account" });
      },
    },
    { id: "sign-out", label: t("shell.signOut"), icon: <LogOutIcon aria-hidden="true" />, onSelect: signOut },
  ];

  return (
    <AppShell
      actions={
        <>
          <ThemeToggle switchToDark={t("shell.switchToDark")} switchToLight={t("shell.switchToLight")} />
          <AccountMenu
            items={accountItems}
            label={t("shell.account")}
          />
        </>
      }
      breadcrumb={
        <Breadcrumb aria-label={t("shell.breadcrumb")}>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>{inSettings ? t("shell.settings") : t("shell.home")}</BreadcrumbPage>
            </BreadcrumbItem>
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
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={pathname === "/"} render={<Link to="/" />} tooltip={t("shell.home")}>
              <HomeIcon aria-hidden="true" />
              <span>{t("shell.home")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
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
      }
      productName={product.name}
    >
      <OfflineBanner />
      <Slot name="banner.entitlement" />
      <Outlet />
    </AppShell>
  );
}
