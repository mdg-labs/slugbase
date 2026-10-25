import { Button, SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton } from "@slugbase/ui";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { folderBackgroundClass } from "../folders/folder-glyph.tsx";
import type { AllFolders } from "../folders/use-all-folders.ts";

export interface SidebarFoldersProps {
  readonly folders: AllFolders;
  /** The folder the bookmarks list is filtered by now, if it is one of the member's. */
  readonly activeId: string | undefined;
}

/**
 * The Folders section of the sidebar (doc 03 navigation structure): each of the member's folders, with its colour dot, as
 * a quick filter of the bookmarks list. A list that could not be read says so and can be read again, and is never shown as
 * having no folders.
 */
export function SidebarFolders({ folders, activeId }: SidebarFoldersProps): ReactElement {
  const { t } = useTranslation();
  let content: ReactElement;
  if (folders.status === "failed") {
    content = (
      <div className="flex flex-col items-start gap-2 px-2 text-sidebar-foreground text-xs group-data-[collapsible=icon]:hidden">
        {t("shell.foldersSection.loadFailed")}
        <Button loading={folders.retrying} onClick={folders.retry} size="xs" type="button" variant="outline">
          {t("shell.foldersSection.retry")}
        </Button>
      </div>
    );
  } else if (folders.status === "loading") {
    content = (
      <div aria-busy="true">
        <span className="sr-only">{t("shell.foldersSection.loading")}</span>
        <SidebarMenuSkeleton />
        <SidebarMenuSkeleton />
      </div>
    );
  } else if (folders.folders.length === 0) {
    content = <p className="px-2 text-sidebar-foreground/70 text-xs group-data-[collapsible=icon]:hidden">{t("shell.foldersSection.empty")}</p>;
  } else {
    content = (
      <SidebarMenu>
        {folders.folders.map((folder) => (
          <SidebarMenuItem key={folder.id}>
            <SidebarMenuButton isActive={folder.id === activeId} render={<Link search={{ folderId: folder.id }} to="/bookmarks" />} tooltip={folder.name}>
              <span aria-hidden="true" className={`size-2.5 rounded-full ${folderBackgroundClass(folder.color)}`} />
              <span>{folder.name}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    );
  }
  return (
    <SidebarGroup className="px-0 pb-0" data-slot="sidebar-folders">
      <SidebarGroupLabel>{t("shell.foldersSection.label")}</SidebarGroupLabel>
      {content}
    </SidebarGroup>
  );
}
