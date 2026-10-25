import { DataTable, ExternalLinkIcon, PencilIcon, RowActions, Trash2Icon, UsageMeter, type DataTableColumn } from "@slugbase/ui/patterns";
import { Link, useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_TAG_SORT, type Tag, type TagSort } from "./tags.ts";

export interface TagsTableProps {
  /** The tags to show, in the order to show them. */
  readonly tags: readonly Tag[];
  /** The count a full bar stands for: the most used tag's of all the member's tags, not only of those shown. */
  readonly largestCount: number;
  /** The sort of the list, which a link that selects a tag keeps. */
  readonly sort: TagSort;
  /** The tag `?tag=` names, whose bookmarks are previewed. */
  readonly selectedId: string | undefined;
  readonly onRename: (tag: Tag) => void;
  readonly onDelete: (tag: Tag) => void;
}

type TagActionHandlers = Pick<TagsTableProps, "onRename" | "onDelete"> & { readonly tag: Tag };

function ActionsCell({ tag, onRename, onDelete }: TagActionHandlers): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const actions = [
    {
      id: "open",
      label: t("tags.actions.open"),
      icon: <ExternalLinkIcon aria-hidden="true" />,
      onSelect: () => {
        void router.navigate({ to: "/bookmarks", search: { tag: [tag.id] } });
      },
    },
    {
      id: "rename",
      label: t("tags.actions.rename"),
      icon: <PencilIcon aria-hidden="true" />,
      onSelect: () => {
        onRename(tag);
      },
    },
    {
      id: "delete",
      label: t("tags.actions.delete"),
      icon: <Trash2Icon aria-hidden="true" />,
      destructive: true,
      onSelect: () => {
        onDelete(tag);
      },
    },
  ];
  return <RowActions actions={actions} label={t("tags.list.actionsFor", { name: tag.name })} />;
}

/**
 * The tags as a table (doc 03 section 7): the name, which selects the tag for the preview, and how many bookmarks carry
 * it with a bar for its share of the largest count, so the sizes read as a distribution. Below `md` each row is a card.
 */
export function TagsTable({ tags, largestCount, sort, selectedId, onRename, onDelete }: TagsTableProps): ReactElement {
  const { t } = useTranslation();
  const columns: readonly DataTableColumn<Tag>[] = [
    {
      id: "name",
      header: t("tags.list.table.name"),
      cardSlot: "title",
      cell: (tag) => (
        <Link
          className="block max-w-64 truncate rounded-sm font-medium text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:text-primary-text lg:max-w-96"
          search={{ tag: tag.id, ...(sort === DEFAULT_TAG_SORT ? {} : { sort }) }}
          to="/tags"
          translate="no"
        >
          {tag.name}
        </Link>
      ),
    },
    {
      id: "bookmarks",
      header: t("tags.list.table.bookmarks"),
      className: "w-48",
      cell: (tag) => <UsageMeter label={tag.name} max={largestCount} value={tag.bookmarkCount} valueLabel={t("tags.list.bookmarkCount", { count: tag.bookmarkCount })} />,
    },
    {
      id: "actions",
      header: t("tags.list.table.actions"),
      hideHeader: true,
      cardSlot: "trailing",
      cell: (tag) => <ActionsCell onDelete={onDelete} onRename={onRename} tag={tag} />,
    },
  ];
  return <DataTable columns={columns} label={t("tags.list.label")} rowKey={(tag) => tag.id} rowSelected={(tag) => tag.id === selectedId} rows={tags} />;
}
