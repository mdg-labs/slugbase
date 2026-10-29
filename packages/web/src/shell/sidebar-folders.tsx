import { Button, SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton } from "@slugbase/ui";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { folderBackgroundClass } from "../folders/folder-glyph.tsx";
import type { Folder } from "../folders/folders.ts";
import type { AllFolders } from "../folders/use-all-folders.ts";

export interface SidebarFoldersProps {
  /** The member's own folders. */
  readonly folders: AllFolders;
  /** The folders other members shared with the member, listed after their own. */
  readonly shared: AllFolders;
  /** The folder the bookmarks list is filtered by now, if it is one of the member's or one shared with them. */
  readonly activeId: string | undefined;
}

function FolderItems({ folders, activeId, sharedBy }: { folders: readonly Folder[]; activeId: string | undefined; sharedBy: boolean }): ReactElement {
  const { t } = useTranslation();
  return (
    <SidebarMenu>
      {folders.map((folder) => {
        const owner = sharedBy ? folder.owner?.displayName : undefined;
        return (
          <SidebarMenuItem key={folder.id}>
            <SidebarMenuButton
              isActive={folder.id === activeId}
              render={<Link search={{ folderId: folder.id }} to="/bookmarks" />}
              tooltip={owner === undefined ? folder.name : t("shell.foldersSection.sharedBy", { name: folder.name, owner })}
            >
              <span aria-hidden="true" className={`size-2.5 rounded-full ${folderBackgroundClass(folder.color)}`} />
              <span>{folder.name}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

/**
 * The Folders section of the sidebar (doc 03 navigation structure): each of the member's folders, with its colour dot, as
 * a quick filter of the bookmarks list, and after them the folders other members shared with the member under a label of
 * their own. A list that could not be read says so and can be read again, and is never shown as having no folders; the
 * shared folders load beside the member's own, so a slow or failed shared list never holds the member's own back.
 */
export function SidebarFolders({ folders, shared, activeId }: SidebarFoldersProps): ReactElement {
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
  } else if (folders.folders.length === 0 && shared.status === "ready" && shared.folders.length === 0) {
    content = <p className="px-2 text-sidebar-foreground/70 text-xs group-data-[collapsible=icon]:hidden">{t("shell.foldersSection.empty")}</p>;
  } else {
    content = (
      <>
        {folders.folders.length === 0 ? null : <FolderItems activeId={activeId} folders={folders.folders} sharedBy={false} />}
        {shared.status === "failed" ? (
          <div className="flex flex-col items-start gap-2 px-2 text-sidebar-foreground text-xs group-data-[collapsible=icon]:hidden">
            {t("shell.foldersSection.sharedLoadFailed")}
            <Button loading={shared.retrying} onClick={shared.retry} size="xs" type="button" variant="outline">
              {t("shell.foldersSection.retry")}
            </Button>
          </div>
        ) : null}
        {shared.status === "ready" && shared.folders.length > 0 ? (
          <>
            <SidebarGroupLabel>{t("shell.foldersSection.shared")}</SidebarGroupLabel>
            <FolderItems activeId={activeId} folders={shared.folders} sharedBy />
          </>
        ) : null}
      </>
    );
  }
  return (
    <SidebarGroup className="px-0 pb-0" data-slot="sidebar-folders">
      <SidebarGroupLabel>{t("shell.foldersSection.label")}</SidebarGroupLabel>
      {content}
    </SidebarGroup>
  );
}
