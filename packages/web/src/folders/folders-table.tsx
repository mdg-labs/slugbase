import { DataTable, ExternalLinkIcon, PaletteIcon, PencilIcon, RowActions, Trash2Icon, type DataTableColumn } from "@slugbase/ui/patterns";
import { useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../i18n/use-format.ts";
import { FolderGlyph } from "./folder-glyph.tsx";
import type { Folder } from "./folders.ts";

export interface FoldersTableProps {
  readonly folders: readonly Folder[];
  readonly onRename: (folder: Folder) => void;
  readonly onRestyle: (folder: Folder) => void;
  readonly onDelete: (folder: Folder) => void;
}

type FolderActionHandlers = Pick<FoldersTableProps, "onRename" | "onRestyle" | "onDelete"> & { readonly folder: Folder };

function ActionsCell({ folder, onRename, onRestyle, onDelete }: FolderActionHandlers): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const actions = [
    {
      id: "open",
      label: t("folders.actions.open"),
      icon: <ExternalLinkIcon aria-hidden="true" />,
      onSelect: () => {
        void router.navigate({ to: "/bookmarks", search: { folderId: folder.id } });
      },
    },
    {
      id: "rename",
      label: t("folders.actions.rename"),
      icon: <PencilIcon aria-hidden="true" />,
      onSelect: () => {
        onRename(folder);
      },
    },
    {
      id: "restyle",
      label: t("folders.actions.restyle"),
      icon: <PaletteIcon aria-hidden="true" />,
      onSelect: () => {
        onRestyle(folder);
      },
    },
    {
      id: "delete",
      label: t("folders.actions.delete"),
      icon: <Trash2Icon aria-hidden="true" />,
      destructive: true,
      onSelect: () => {
        onDelete(folder);
      },
    },
  ];
  return <RowActions actions={actions} label={t("folders.list.actionsFor", { name: folder.name })} />;
}

/**
 * The folders as a table (doc 03 section 6): the icon in its colour with the name, how many bookmarks are filed in the
 * folder, when it last changed, and the actions of the row. The order is the page's; below `md` each row is a card.
 */
export function FoldersTable({ folders, onRename, onRestyle, onDelete }: FoldersTableProps): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const columns: readonly DataTableColumn<Folder>[] = [
    {
      id: "name",
      header: t("folders.list.table.name"),
      cardSlot: "title",
      cell: (folder) => (
        <span className="flex items-center gap-3">
          <FolderGlyph color={folder.color} icon={folder.icon} />
          <span className="max-w-64 truncate font-medium text-sm lg:max-w-96">{folder.name}</span>
        </span>
      ),
    },
    {
      id: "bookmarks",
      header: t("folders.list.table.bookmarks"),
      cell: (folder) => t("folders.list.bookmarkCount", { count: folder.bookmarkCount }),
    },
    {
      id: "updated",
      header: t("folders.list.table.updated"),
      cell: (folder) => format.relativeTime(new Date(folder.updatedAt)),
    },
    {
      id: "actions",
      header: t("folders.list.table.actions"),
      hideHeader: true,
      cardSlot: "trailing",
      cell: (folder) => <ActionsCell folder={folder} onDelete={onDelete} onRename={onRename} onRestyle={onRestyle} />,
    },
  ];
  return <DataTable columns={columns} label={t("folders.list.label")} rowKey={(folder) => folder.id} rows={folders} />;
}
