import { Button, Skeleton } from "@slugbase/ui";
import { Banner, DataTable, EmptyState, LoadMore, Loading, SettingsSection, Trash2Icon, CompassIcon, type DataTableColumn } from "@slugbase/ui/patterns";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../i18n/use-format.ts";
import { goPreferencesQuery, type GoPreference } from "./forwarding.ts";
import { useRemoveGoPreference } from "./use-forwarding.ts";

const SKELETON_ROWS = ["a", "b", "c"] as const;

function ChoicesTable({ choices, onRemove }: { readonly choices: readonly GoPreference[]; readonly onRemove: (choice: GoPreference) => void }): ReactElement {
  const { t } = useTranslation();
  const columns: readonly DataTableColumn<GoPreference>[] = [
    {
      id: "slug",
      header: t("forwarding.choices.table.slug"),
      cardSlot: "title",
      cell: (choice) => (
        <span className="font-mono text-xs" translate="no">
          {`/go/${choice.slug}`}
        </span>
      ),
    },
    {
      id: "bookmark",
      header: t("forwarding.choices.table.bookmark"),
      cell: (choice) => (
        <span className="block max-w-64 truncate text-sm" translate="no">
          {choice.title}
        </span>
      ),
    },
    {
      id: "host",
      header: t("forwarding.choices.table.host"),
      cell: (choice) => (
        <span className="block max-w-48 truncate font-mono text-muted-foreground text-xs" translate="no">
          {choice.host}
        </span>
      ),
    },
    {
      id: "owner",
      header: t("forwarding.choices.table.owner"),
      cell: (choice) => (choice.owner === null ? t("forwarding.choices.you") : <span translate="no">{choice.owner.displayName}</span>),
    },
    {
      id: "actions",
      header: t("forwarding.choices.table.actions"),
      hideHeader: true,
      cardSlot: "trailing",
      cell: (choice) => (
        <Button
          aria-label={t("forwarding.choices.removeFor", { slug: choice.slug })}
          onClick={() => {
            onRemove(choice);
          }}
          size="sm"
          variant="ghost"
        >
          <Trash2Icon aria-hidden="true" />
          {t("forwarding.choices.remove")}
        </Button>
      ),
    },
  ];
  return <DataTable columns={columns} label={t("forwarding.choices.label")} rowKey={(choice) => choice.slug} rows={choices} />;
}

/**
 * "Remembered choices" (doc 03 section 8, doc 02 section 6.4): the bookmark each slug goes to for the member where they chose
 * one of several. Remove takes the choice off the list at once, without a confirmation, and the toast offers an undo.
 */
export function ChoicesSection(): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const query = useInfiniteQuery(goPreferencesQuery(router.options.context.api));
  const { remove, hidden } = useRemoveGoPreference();
  const items = (query.data?.pages.flatMap((page) => page.items) ?? []).filter((choice) => !hidden.has(choice.slug));
  const retry = (
    <Button
      loading={query.isFetching}
      onClick={() => {
        void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch());
      }}
      size="sm"
      variant="outline"
    >
      {t("forwarding.choices.retry")}
    </Button>
  );

  let body: ReactElement;
  if (query.isPending) {
    body = (
      <Loading className="p-0" label={t("forwarding.choices.loading")}>
        <div className="flex flex-col gap-2">
          {SKELETON_ROWS.map((key) => (
            <Skeleton className="h-12 rounded-lg" key={key} />
          ))}
        </div>
      </Loading>
    );
  } else if (query.data === undefined) {
    body = <Banner action={retry} title={t("forwarding.choices.loadFailed")} variant="error" />;
  } else if (items.length === 0 && !query.hasNextPage) {
    body = (
      <EmptyState
        description={t("forwarding.choices.empty.description")}
        headingLevel={3}
        icon={<CompassIcon aria-hidden="true" />}
        title={t("forwarding.choices.empty.title")}
      />
    );
  } else {
    body = (
      <>
        {query.isError ? (
          <Banner action={retry} title={query.isFetchNextPageError ? t("forwarding.choices.loadMoreFailed") : t("forwarding.choices.refreshFailed")} variant="error" />
        ) : null}
        <ChoicesTable choices={items} onRemove={remove} />
        <LoadMore
          count={t("forwarding.choices.count", { shown: format.number(items.length) })}
          hasMore={query.hasNextPage}
          loadMoreLabel={t("forwarding.choices.loadMore")}
          loading={query.isFetchingNextPage}
          onLoadMore={() => {
            void query.fetchNextPage();
          }}
        />
      </>
    );
  }

  return (
    <SettingsSection description={t("forwarding.choices.description")} title={t("forwarding.choices.title")}>
      <div className="flex flex-col gap-4">{body}</div>
    </SettingsSection>
  );
}
