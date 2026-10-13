import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@slugbase/ui";
import { AppShell, HomeIcon, LifeBuoyIcon, ThemeToggle } from "@slugbase/ui/patterns";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useConfig } from "../config/config-context.tsx";
import { docsUrl } from "./docs-url.ts";

/**
 * The in-app layout route: the app shell around the page of the current route.
 * The sidebar lists the routes that exist; each page adds its own as it arrives.
 */
export function AppLayout(): ReactElement {
  const { t } = useTranslation();
  const { product, docsBaseUrl } = useConfig();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <AppShell
      actions={<ThemeToggle switchToDark={t("shell.switchToDark")} switchToLight={t("shell.switchToLight")} />}
      breadcrumb={
        <Breadcrumb aria-label={t("shell.breadcrumb")}>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>{t("shell.home")}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      }
      footer={
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
        </SidebarMenu>
      }
      productName={product.name}
    >
      <Outlet />
    </AppShell>
  );
}
