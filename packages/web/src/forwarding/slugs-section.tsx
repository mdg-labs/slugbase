import { Button, Skeleton, Switch } from "@slugbase/ui";
import { Banner, DataTable, EmptyState, ForwardIcon, Loading, LoadMore, PencilIcon, PlusIcon, PowerOffIcon, CopyIcon, RowActions, SettingsSection, feedbackToast, type DataTableColumn, type RowAction } from "@slugbase/ui/patterns";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useBookmarkModal } from "../bookmarks/modal-search.ts";
import { bookmarkListQuery, type Bookmark } from "../bookmarks/bookmarks.ts";
import { useConfig } from "../config/config-context.tsx";
import { useFormat } from "../i18n/use-format.ts";
import { SLUG_LIST_PARAMS, goAddress } from "./forwarding.ts";
import { usePendingForwarding, useSetForwarding } from "./use-forwarding.ts";

const SKELETON_ROWS = ["a", "b", "c", "d"] as const;

interface RowHandlers {
  readonly onEdit: (bookmark: Bookmark) => void;
  readonly onCopy: (bookmark: Bookmark) => void;
  readonly onForwarding: (bookmark: Bookmark, forwarding: boolean) => void;
  readonly pending: ReadonlySet<string>;
}

function SlugActions({ bookmark, onEdit, onCopy, onForwarding, pending }: RowHandlers & { readonly bookmark: Bookmark }): ReactElement {
  const { t } = useTranslation();
  const slug = bookmark.slug ?? "";
  const actions: readonly RowAction[] = [
    { id: "edit", label: t("forwarding.slugs.edit"), icon: <PencilIcon aria-hidden="true" />, onSelect: () => { onEdit(bookmark); } },
    { id: "copy", label: t("forwarding.slugs.copy"), icon: <CopyIcon aria-hidden="true" />, onSelect: () => { onCopy(bookmark); } },
    {
      id: "turnOff",
      label: t("forwarding.slugs.turnOff"),
      icon: <PowerOffIcon aria-hidden="true" />,
      disabled: !bookmark.forwarding || pending.has(bookmark.id),
      onSelect: () => { onForwarding(bookmark, false); },
    },
  ];
  return <RowActions actions={actions} label={t("forwarding.slugs.actionsFor", { slug })} />;
}

function SlugsTable({ bookmarks, ...handlers }: RowHandlers & { readonly bookmarks: readonly Bookmark[] }): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const columns: readonly DataTableColumn<Bookmark>[] = [
    {
      id: "slug",
      header: t("forwarding.slugs.table.slug"),
      cardSlot: "title",
      cell: (bookmark) => (
        <span className="font-mono text-xs" translate="no">
          {`/go/${bookmark.slug ?? ""}`}
        </span>
      ),
    },
    {
      id: "host",
      header: t("forwarding.slugs.table.host"),
      cell: (bookmark) => (
        <span className="block max-w-48 truncate font-mono text-muted-foreground text-xs" translate="no">
          {bookmark.host}
        </span>
      ),
    },
    {
      id: "forwarding",
      header: t("forwarding.slugs.table.forwarding"),
      cell: (bookmark) => (
        <Switch
          aria-label={t("forwarding.slugs.switch", { slug: bookmark.slug ?? "" })}
          checked={bookmark.forwarding}
          disabled={handlers.pending.has(bookmark.id)}
          onCheckedChange={(next) => {
            handlers.onForwarding(bookmark, next);
          }}
        />
      ),
    },
    { id: "opens", header: t("forwarding.slugs.table.opens"), cell: (bookmark) => format.number(bookmark.openCount) },
    {
      id: "lastOpened",
      header: t("forwarding.slugs.table.lastOpened"),
      cell: (bookmark) =>
        bookmark.lastOpenedAt === null ? <span className="text-muted-foreground">{t("forwarding.slugs.table.never")}</span> : format.relativeTime(new Date(bookmark.lastOpenedAt)),
    },
    {
      id: "actions",
      header: t("forwarding.slugs.table.actions"),
      hideHeader: true,
      cardSlot: "trailing",
      cell: (bookmark) => <SlugActions bookmark={bookmark} {...handlers} />,
    },
  ];
  return <DataTable columns={columns} label={t("forwarding.slugs.label")} rowKey={(bookmark) => bookmark.id} rows={bookmarks} />;
}

/**
 * "Your slugs" (doc 03 section 8): the member's own bookmarks that have a slug, with the forwarding Switch of each, which saves
 * at once and is put back with a toast when the server refuses. A row's actions are Edit (the bookmark modal), Copy address and
 * Turn off forwarding.
 */
export function SlugsSection(): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const { origin } = useConfig();
  const modal = useBookmarkModal();
  const { setForwarding } = useSetForwarding();
  const pending = usePendingForwarding();
  const query = useInfiniteQuery(bookmarkListQuery(router.options.context.api, SLUG_LIST_PARAMS));
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const lastPage = query.data?.pages.at(-1);

  const copy = (bookmark: Bookmark): void => {
    const address = goAddress(origin, bookmark.slug ?? "");
    // The clipboard is missing on a page that is not a secure context, such as an instance served over http.
    void (async () => {
      try {
        await globalThis.navigator.clipboard.writeText(address);
      } catch {
        feedbackToast.error(t("forwarding.slugs.copyFailed"));
        return;
      }
      feedbackToast.success(t("forwarding.slugs.copied", { address }));
    })();
  };
  const retry = (
    <Button
      loading={query.isFetching}
      onClick={() => {
        void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch());
      }}
      size="sm"
      variant="outline"
    >
      {t("forwarding.slugs.retry")}
    </Button>
  );

  let body: ReactElement;
  if (query.isPending) {
    body = (
      <Loading className="p-0" label={t("forwarding.slugs.loading")}>
        <div className="flex flex-col gap-2">
          {SKELETON_ROWS.map((key) => (
            <Skeleton className="h-12 rounded-lg" key={key} />
          ))}
        </div>
      </Loading>
    );
  } else if (query.data === undefined) {
    body = <Banner action={retry} title={t("forwarding.slugs.loadFailed")} variant="error" />;
  } else if (items.length === 0 && !query.hasNextPage) {
    body = (
      <EmptyState
        actions={
          <Button
            onClick={() => {
              modal.openNew();
            }}
            variant="outline"
          >
            <PlusIcon aria-hidden="true" />
            {t("forwarding.slugs.empty.action")}
          </Button>
        }
        description={t("forwarding.slugs.empty.description")}
        headingLevel={3}
        icon={<ForwardIcon aria-hidden="true" />}
        title={t("forwarding.slugs.empty.title")}
      />
    );
  } else {
    const shown = format.number(items.length);
    const total = lastPage?.total;
    body = (
      <>
        {query.isError ? (
          <Banner action={retry} title={query.isFetchNextPageError ? t("forwarding.slugs.loadMoreFailed") : t("forwarding.slugs.refreshFailed")} variant="error" />
        ) : null}
        <SlugsTable
          bookmarks={items}
          onCopy={copy}
          onEdit={(bookmark) => {
            modal.edit(bookmark.id);
          }}
          onForwarding={setForwarding}
          pending={pending}
        />
        <LoadMore
          count={
            lastPage?.totalAtLeast !== undefined && total === null
              ? t("forwarding.slugs.countAtLeast", { shown, total: format.number(lastPage.totalAtLeast) })
              : t("forwarding.slugs.count", { shown, total: format.number(total ?? items.length) })
          }
          hasMore={query.hasNextPage}
          loadMoreLabel={t("forwarding.slugs.loadMore")}
          loading={query.isFetchingNextPage}
          onLoadMore={() => {
            void query.fetchNextPage();
          }}
        />
      </>
    );
  }

  return (
    <SettingsSection description={t("forwarding.slugs.description")} title={t("forwarding.slugs.title")}>
      <div className="flex flex-col gap-4">{body}</div>
    </SettingsSection>
  );
}
