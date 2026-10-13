import type { ReactElement, ReactNode } from "react";
import { Separator } from "../components/ui/separator.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "../components/ui/sidebar.tsx";
import { SlugBaseMark } from "./slugbase-mark.tsx";

/** The texts of the shell's own controls. `@slugbase/ui` carries no catalogs, so the app passes them in its language. */
export interface AppShellLabels {
  /** The skip link that moves focus past the navigation to the page. */
  skipToContent: string;
  /** The sidebar trigger of the top bar. */
  toggleSidebar: string;
  /** The `nav` landmark around the sidebar's links. */
  navigation: string;
  /** The title, description and close button of the drawer shown below the `md` breakpoint. */
  drawerTitle: string;
  drawerDescription: string;
  drawerClose: string;
}

export interface AppShellProps {
  labels: AppShellLabels;
  /** Written beside the mark in the sidebar header. */
  productName: string;
  /** The sidebar's links: a `SidebarMenu`. */
  navigation: ReactNode;
  /** Below the links, for example the help link. */
  footer?: ReactNode;
  /** The top bar's breadcrumb. */
  breadcrumb: ReactNode;
  /** The controls at the end of the top bar. */
  actions?: ReactNode;
  /** The page. */
  children: ReactNode;
  /** Whether the sidebar starts expanded. */
  defaultOpen?: boolean;
}

export const MAIN_CONTENT_ID = "main-content";

// The sidebar collapses to its icons, not off the screen.
const SIDEBAR_COLLAPSE = "icon";

/**
 * The in-app frame (doc 03 "App shell"): a sidebar that collapses to icons and
 * becomes a drawer below the `md` breakpoint, a top bar with the breadcrumb and
 * its controls, and the page in the `main` landmark. The first focusable
 * element is a link that skips to the page.
 */
export function AppShell({
  labels,
  productName,
  navigation,
  footer,
  breadcrumb,
  actions,
  children,
  defaultOpen = true,
}: AppShellProps): ReactElement {
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <a
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:start-2 focus-visible:top-2 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-background focus-visible:px-3 focus-visible:py-2 focus-visible:text-foreground focus-visible:text-sm focus-visible:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
        href={`#${MAIN_CONTENT_ID}`}
      >
        {labels.skipToContent}
      </a>
      <Sidebar
        collapsible={SIDEBAR_COLLAPSE}
        mobileLabels={{ close: labels.drawerClose, description: labels.drawerDescription, title: labels.drawerTitle }}
      >
        <SidebarHeader>
          <div className="flex h-8 items-center gap-2 px-2 font-semibold">
            <SlugBaseMark className="size-5 shrink-0 text-primary" />
            <span className="truncate group-data-[collapsible=icon]:hidden">{productName}</span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <nav aria-label={labels.navigation}>{navigation}</nav>
          </SidebarGroup>
        </SidebarContent>
        {footer === undefined ? null : <SidebarFooter>{footer}</SidebarFooter>}
      </Sidebar>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
          <SidebarTrigger label={labels.toggleSidebar} />
          <Separator className="data-[orientation=vertical]:h-4" orientation="vertical" />
          <div className="min-w-0 flex-1">{breadcrumb}</div>
          {actions === undefined ? null : <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </header>
        <SidebarInset className="outline-none" id={MAIN_CONTENT_ID} tabIndex={-1}>
          {children}
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
