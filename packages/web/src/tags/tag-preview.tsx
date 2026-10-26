import { Button, Skeleton } from "@slugbase/ui";
import { Banner, DataTable, Loading, type DataTableColumn } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { isHttpUrl, recordOpen, type Bookmark } from "../bookmarks/bookmarks.ts";
import { useFormat } from "../i18n/use-format.ts";
import { TAG_PREVIEW_SIZE, tagPreviewQuery, type Tag } from "./tags.ts";

const SKELETON_ROWS = Array.from({ length: TAG_PREVIEW_SIZE }, (_, index) => index);

function TitleCell({ bookmark }: { readonly bookmark: Bookmark }): ReactElement {
  const router = useRouter();
  // The title and host are text, whatever they hold; the title follows the address only when that is an http or https one (T14).
  const title = <span className="truncate font-medium text-sm">{bookmark.title}</span>;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {isHttpUrl(bookmark.url) ? (
        <a
          className="flex min-w-0 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          href={bookmark.url}
          onClick={() => {
            recordOpen(router.options.context.api, bookmark.id);
          }}
        >
          {title}
        </a>
      ) : (
        title
      )}
      <span className="truncate text-muted-foreground text-xs">{bookmark.host}</span>
    </span>
  );
}

/**
 * The newest bookmarks that carry `tag` and the way on to all of them in Bookmarks (doc 03 section 7). A preview that
 * could not be read says so with the way to try again; it is never shown as a tag with no bookmarks.
 */
export function TagPreview({ tag }: { readonly tag: Tag }): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const preview = useQuery(tagPreviewQuery(router.options.context.api, tag.id));
  const columns: readonly DataTableColumn<Bookmark>[] = [
    {
      id: "title",
      header: t("tags.preview.table.title"),
      cardSlot: "title",
      cell: (bookmark) => <TitleCell bookmark={bookmark} />,
    },
    {
      id: "added",
      header: t("tags.preview.table.added"),
      cell: (bookmark) => <time dateTime={bookmark.createdAt}>{format.relativeTime(new Date(bookmark.createdAt))}</time>,
    },
  ];

  let body: ReactElement;
  if (preview.isPending) {
    body = (
      <Loading className="p-0" label={t("tags.preview.loading")}>
        <div className="flex flex-col gap-2">
          {SKELETON_ROWS.map((key) => (
            <Skeleton className="h-12 rounded-lg" key={key} />
          ))}
        </div>
      </Loading>
    );
  } else if (preview.isError) {
    body = (
      <Banner
        action={
          <Button
            loading={preview.isFetching}
            onClick={() => {
              void preview.refetch();
            }}
            size="sm"
            variant="outline"
          >
            {t("tags.preview.retry")}
          </Button>
        }
        title={t("tags.preview.loadFailed")}
        variant="error"
      />
    );
  } else if (preview.data.items.length === 0) {
    body = <p className="text-muted-foreground text-sm">{t("tags.preview.empty")}</p>;
  } else {
    body = <DataTable columns={columns} label={t("tags.preview.label", { name: tag.name })} rowKey={(bookmark) => bookmark.id} rows={preview.data.items} />;
  }

  return (
    <div className="flex flex-col gap-4">
      {body}
      <Button render={<Link search={{ tag: [tag.id] }} to="/bookmarks" />} variant="outline">
        {t("tags.preview.viewAll")}
      </Button>
    </div>
  );
}
