import { Skeleton } from "@slugbase/ui";
import { MetricTile, SlugChip, TagLink, TileGrid, TileLink } from "@slugbase/ui/patterns";
import { Link, useRouter } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isHttpUrl, recordOpen } from "../bookmarks/bookmarks.ts";
import { useSharingGranted } from "../sharing/index.ts";
import { useFormat } from "../i18n/use-format.ts";
import { SHARED_BY_YOU_SEARCH, SHARED_WITH_YOU_SEARCH, type Dashboard, type DashboardBookmark } from "./dashboard.ts";

function Row({ id, title, action, children }: { readonly id: string; readonly title: string; readonly action?: ReactNode; readonly children: ReactNode }): ReactElement {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold text-base" id={id}>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Row 1, the counts (doc 03 section 2): the tile of what is shared with the member appears only when the answer carries that count and the workspace grants sharing. */
export function CountsRow({ counts }: { readonly counts: Dashboard["counts"] }): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const sharingGranted = useSharingGranted();
  return (
    <div aria-label={t("home.counts.label")} className="grid grid-cols-2 gap-3 md:grid-cols-4" role="group">
      <MetricTile label={t("home.counts.bookmarks")} value={format.number(counts.bookmarks)} />
      <MetricTile label={t("home.counts.folders")} value={format.number(counts.folders)} />
      <MetricTile label={t("home.counts.tags")} value={format.number(counts.tags)} />
      {counts.sharedWithYou === null || !sharingGranted ? null : <MetricTile label={t("home.counts.sharedWithYou")} value={format.number(counts.sharedWithYou)} />}
    </div>
  );
}

function Hint({ children }: { readonly children: ReactNode }): ReactElement {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

/** Row 2: the member's most opened slugs; a tile goes to `/go/<slug>` and its hover text is the address it forwards to. */
export function QuickAccessRow({ bookmarks }: { readonly bookmarks: readonly DashboardBookmark[] }): ReactElement {
  const { t } = useTranslation();
  const withSlug = bookmarks.flatMap((bookmark) => (bookmark.slug === null ? [] : [{ bookmark, slug: bookmark.slug }]));
  return (
    <Row id="home-quick-access" title={t("home.quickAccess.title")}>
      {withSlug.length === 0 ? (
        <Hint>{t("home.quickAccess.empty")}</Hint>
      ) : (
        <TileGrid label={t("home.quickAccess.label")}>
          {withSlug.map(({ bookmark, slug }) => (
            <TileLink hint={bookmark.url} href={`/go/${encodeURIComponent(slug)}`} host={bookmark.host} key={bookmark.id} title={bookmark.title}>
              <SlugChip slug={slug} />
            </TileLink>
          ))}
        </TileGrid>
      )}
    </Row>
  );
}

/** Row 3: the pinned bookmarks as compact cards that follow the bookmark's own address (only an `http` or `https` one, T14), with the link to the filtered list. */
export function PinnedRow({ bookmarks }: { readonly bookmarks: readonly DashboardBookmark[] }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <Row
      action={
        <Link className="rounded-sm font-medium text-primary-text text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" search={{ pinned: true }} to="/bookmarks">
          {t("home.pinned.viewAll")}
        </Link>
      }
      id="home-pinned"
      title={t("home.pinned.title")}
    >
      {bookmarks.length === 0 ? (
        <Hint>{t("home.pinned.empty")}</Hint>
      ) : (
        <TileGrid label={t("home.pinned.label")}>
          {bookmarks.map((bookmark) => (
            <TileLink
              {...(isHttpUrl(bookmark.url) ? { href: bookmark.url } : {})}
              key={bookmark.id}
              host={bookmark.host}
              onOpen={() => {
                recordOpen(router.options.context.api, bookmark.id);
              }}
              subtitle={bookmark.host}
              title={bookmark.title}
            />
          ))}
        </TileGrid>
      )}
    </Row>
  );
}

/** Row 4: the member's most used tags, each a link to the bookmarks that carry it. */
export function TopTagsRow({ tags }: { readonly tags: Dashboard["topTags"] }): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Row id="home-tags" title={t("home.tags.title")}>
      {tags.length === 0 ? (
        <Hint>{t("home.tags.empty")}</Hint>
      ) : (
        <ul aria-labelledby="home-tags" className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <li key={tag.id}>
              <TagLink count={format.number(tag.bookmarkCount)} link={<Link search={{ tag: [tag.id] }} to="/bookmarks" />} name={tag.name} />
            </li>
          ))}
        </ul>
      )}
    </Row>
  );
}

/** Row 4, beside the tags: how many bookmarks are shared with the member and by the member, each a link to the list of that scope. Absent unless the answer carries the counts and the workspace grants sharing. */
export function SharingRow({ sharing }: { readonly sharing: Dashboard["sharing"] }): ReactElement | null {
  const { t } = useTranslation();
  const format = useFormat();
  const sharingGranted = useSharingGranted();
  if (sharing === null || !sharingGranted) {
    return null;
  }
  return (
    <Row id="home-sharing" title={t("home.sharing.title")}>
      <ul aria-labelledby="home-sharing" className="flex flex-wrap gap-2">
        <li>
          <TagLink count={format.number(sharing.sharedWithYou)} link={<Link search={SHARED_WITH_YOU_SEARCH} to="/bookmarks" />} name={t("home.sharing.withYou")} />
        </li>
        <li>
          <TagLink count={format.number(sharing.sharedByYou)} link={<Link search={SHARED_BY_YOU_SEARCH} to="/bookmarks" />} name={t("home.sharing.byYou")} />
        </li>
      </ul>
    </Row>
  );
}

const TILE_KEYS = ["a", "b", "c"] as const;
const QUICK_KEYS = ["a", "b", "c", "d"] as const;

/** The shapes of the rows while the answer is on its way. */
export function HomeSkeleton(): ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-11 rounded-lg" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {TILE_KEYS.map((key) => (
          <Skeleton className="h-20 rounded-2xl" key={key} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {QUICK_KEYS.map((key) => (
          <Skeleton className="h-16 rounded-2xl" key={key} />
        ))}
      </div>
    </div>
  );
}
