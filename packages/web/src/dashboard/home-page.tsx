import { Button } from "@slugbase/ui";
import { Banner, EmptyState, InboxIcon, PlusIcon, SearchEntry } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCanSaveBookmarks } from "../bookmarks/can-save-bookmarks.ts";
import { useBookmarkModal } from "../bookmarks/modal-search.ts";
import { useConfig } from "../config/config-context.tsx";
import { Slot } from "../extensions/index.ts";
import { usePaletteState } from "../palette/palette-state.tsx";
import { isApplePlatform } from "../palette/platform.ts";
import { CountsRow, HomeSkeleton, PinnedRow, QuickAccessRow, TopTagsRow } from "./dashboard-rows.tsx";
import { dashboardQuery } from "./dashboard.ts";

// The shell's main area has no padding of its own: each page keeps its content off the edges, as the settings and admin layouts do.
const PAGE_FRAME = "flex w-full min-w-0 flex-col gap-4 p-4 md:p-6";

function HomeSearch(): ReactElement {
  const { t } = useTranslation();
  const { setOpen } = usePaletteState();
  const shortcut = [isApplePlatform() ? "⌘" : t("shortcuts.key.ctrl"), "K"];
  return (
    <SearchEntry
      label={t("home.search.label")}
      onClick={() => {
        setOpen(true);
      }}
      shortcut={shortcut}
    />
  );
}

function NoBookmarks(): ReactElement {
  const { t } = useTranslation();
  const modal = useBookmarkModal();
  const canSave = useCanSaveBookmarks();
  return (
    <EmptyState
      actions={
        <div className="flex flex-wrap justify-center gap-2">
          {canSave ? (
            <Button
              onClick={() => {
                modal.openNew();
              }}
            >
              <PlusIcon aria-hidden="true" />
              {t("bookmarks.new")}
            </Button>
          ) : null}
          <Button render={<Link to="/forwarding" />} variant="outline">
            {t("home.empty.forwarding")}
          </Button>
        </div>
      }
      description={t("home.empty.description")}
      icon={<InboxIcon aria-hidden="true" />}
      title={t("home.empty.title")}
    />
  );
}

/**
 * `/` (doc 03 section 2, doc 02 section 9.3): the extension slot, the counts and the search that opens the palette, then the
 * quick access slugs, the pinned bookmarks and the most used tags, all read in one call. A workspace with no bookmarks gets the
 * teaching empty state in place of the three lists. The heading and the search do not wait for the answer.
 */
export function HomePage(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { product } = useConfig();
  const dashboard = useQuery(dashboardQuery(router.options.context.api));
  const data = dashboard.data;
  const retry = (
    <Button
      loading={dashboard.isFetching}
      onClick={() => {
        void dashboard.refetch();
      }}
      size="sm"
      variant="outline"
    >
      {t("home.retry")}
    </Button>
  );

  let body: ReactElement | null = null;
  if (data !== undefined) {
    body = (
      <>
        {dashboard.isError ? <Banner action={retry} title={t("home.refreshFailed")} variant="warning" /> : null}
        <CountsRow counts={data.counts} />
        {data.counts.bookmarks === 0 ? (
          <NoBookmarks />
        ) : (
          <>
            <QuickAccessRow bookmarks={data.quickAccess} />
            <PinnedRow bookmarks={data.pinned} />
            <TopTagsRow tags={data.topTags} />
          </>
        )}
      </>
    );
  } else if (dashboard.isError) {
    body = <Banner action={retry} description={t("home.loadFailed.description")} title={t("home.loadFailed.title")} variant="error" />;
  } else {
    body = (
      <div aria-busy="true" aria-label={t("home.loading")} role="status">
        <HomeSkeleton />
      </div>
    );
  }

  return (
    <div className={PAGE_FRAME}>
      <Slot name="dashboard.top" />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-semibold text-2xl leading-none">{t("home.title", { name: product.name })}</h1>
        <p className="text-muted-foreground text-sm">{t("home.tagline")}</p>
      </div>
      <HomeSearch />
      {body}
    </div>
  );
}
