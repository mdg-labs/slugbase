import { Button, Input, Skeleton, useIsMobile } from "@slugbase/ui";
import { Banner, Confirm, EmptyState, InlineNote, Loading, SelectField, SidePanel, TagIcon } from "@slugbase/ui/patterns";
import { Link } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { rateLimitMessage } from "../bookmarks/rate-limit-message.ts";
import { TagPreview } from "./tag-preview.tsx";
import { TagRenameForm } from "./tag-rename-form.tsx";
import { TagsTable } from "./tags-table.tsx";
import { TAG_SORTS, tagFailureOf, visibleTags, type Tag, type TagSort } from "./tags.ts";
import { useTagPageSearch } from "./tags-search.ts";
import { useAllTags } from "./use-all-tags.ts";
import { useDeleteTag } from "./use-delete-tag.ts";

// The shell's main area has no padding of its own: each page keeps its content off the edges, as the settings and admin layouts do.
const PAGE_FRAME = "flex w-full min-w-0 flex-col gap-4 p-4 md:p-6";

const SKELETON_ROWS = ["a", "b", "c", "d", "e"] as const;

function isSort(value: string): value is TagSort {
  return (TAG_SORTS as readonly string[]).includes(value);
}

/**
 * `/tags` (doc 03 section 7, doc 02 section 7.2): the member's tags with how many bookmarks carry each and a bar for its
 * share, searched by name and sorted by name or count, and beside them a preview of the newest bookmarks of the tag the
 * address names. Rename, with a merge offered when the name is another tag's, and Delete are actions of the rows. Below
 * `md` the preview opens as a side panel. The list is read to the end, so the search and the bars cover every tag.
 */
export function TagsPage(): ReactElement {
  const { t } = useTranslation();
  const narrow = useIsMobile();
  const { tag: selectedId, sort, select, setSort } = useTagPageSearch();
  const all = useAllTags();
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<Tag | undefined>(undefined);
  const [deleting, setDeleting] = useState<Tag | undefined>(undefined);
  const remove = useDeleteTag((id) => {
    setDeleting(undefined);
    if (id === selectedId) {
      select(undefined, { replace: true });
    }
  });

  const startDelete = (tag: Tag): void => {
    remove.reset();
    setDeleting(tag);
  };
  const deleteFailure = remove.isError ? tagFailureOf(remove.error) : undefined;
  let deleteMessage: string | undefined;
  if (deleteFailure?.kind === "notFound") {
    deleteMessage = t("tags.delete.error.notFound");
  } else if (deleteFailure?.kind === "rateLimited") {
    deleteMessage = rateLimitMessage(t, deleteFailure.seconds);
  }

  const shown = visibleTags(all.tags, search, sort);
  const largestCount = Math.max(1, ...all.tags.map((tag) => tag.bookmarkCount));
  const selected = all.tags.find((tag) => tag.id === selectedId);
  const retry = (
    <Button loading={all.retrying} onClick={all.retry} size="sm" variant="outline">
      {t("tags.list.retry")}
    </Button>
  );

  let list: ReactElement;
  if (all.status === "loading") {
    list = (
      <Loading className="p-0" label={t("tags.list.loading")}>
        <div className="flex flex-col gap-2">
          {SKELETON_ROWS.map((key) => (
            <Skeleton className="h-12 rounded-lg" key={key} />
          ))}
        </div>
      </Loading>
    );
  } else if (all.status === "failed") {
    list = <Banner action={retry} title={t("tags.list.loadFailed")} variant="error" />;
  } else if (all.tags.length === 0) {
    list = (
      <EmptyState
        actions={
          <Button render={<Link to="/bookmarks" />} variant="outline">
            {t("tags.list.empty.action")}
          </Button>
        }
        description={t("tags.list.empty.description")}
        headingLevel={2}
        icon={<TagIcon aria-hidden="true" />}
        title={t("tags.list.empty.title")}
      />
    );
  } else if (shown.length === 0) {
    list = (
      <EmptyState
        actions={
          <Button
            onClick={() => {
              setSearch("");
            }}
            variant="outline"
          >
            {t("tags.search.clear")}
          </Button>
        }
        description={t("tags.search.none.description", { query: search.trim() })}
        headingLevel={2}
        title={t("tags.search.none.title")}
      />
    );
  } else {
    list = <TagsTable largestCount={largestCount} onDelete={startDelete} onRename={setRenaming} selectedId={selectedId} sort={sort} tags={shown} />;
  }

  const sortOptions = [
    { value: "name", label: t("tags.sort.name") },
    { value: "count", label: t("tags.sort.count") },
  ] as const satisfies readonly { value: TagSort; label: string }[];

  // An address that names a tag the member does not have says so once the list is read; it is not a list that is still loading or failed.
  const placeholder =
      all.status === "ready" && selectedId !== undefined ? (
        <Banner title={t("tags.preview.missing")} variant="warning" />
      ) : (
        <EmptyState description={t("tags.preview.placeholder.description")} headingLevel={2} icon={<TagIcon aria-hidden="true" />} title={t("tags.preview.placeholder.title")} />
      );

  return (
    <div className={PAGE_FRAME}>
      <h1 className="font-semibold text-2xl leading-none">{t("tags.page.title")}</h1>
      <InlineNote>{t("tags.note")}</InlineNote>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          {all.status === "ready" && all.tags.length > 0 ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Input
                aria-label={t("tags.search.label")}
                autoComplete="off"
                className="sm:flex-1"
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
                placeholder={t("tags.search.placeholder")}
                type="search"
                value={search}
              />
              <SelectField
                className="sm:w-44"
                label={t("tags.sort.label")}
                onValueChange={(value) => {
                  if (isSort(value)) {
                    setSort(value);
                  }
                }}
                options={sortOptions}
                value={sort}
              />
            </div>
          ) : null}
          {list}
        </div>
        {narrow ? null : (
          <div className="flex min-w-0 flex-col gap-4 md:sticky md:top-4 md:self-start">
            {selected === undefined ? (
              placeholder
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <h2 className="truncate font-semibold text-lg leading-tight" translate="no">
                    {selected.name}
                  </h2>
                  <p className="text-muted-foreground text-sm">{t("tags.list.bookmarkCount", { count: selected.bookmarkCount })}</p>
                </div>
                <TagPreview key={selected.id} tag={selected} />
              </>
            )}
          </div>
        )}
      </div>
      {narrow ? (
        <SidePanel
          closeLabel={t("tags.preview.close")}
          description={selected === undefined ? undefined : t("tags.list.bookmarkCount", { count: selected.bookmarkCount })}
          onOpenChange={(open) => {
            if (!open) {
              select(undefined, { replace: true });
            }
          }}
          open={selected !== undefined}
          title={selected?.name ?? ""}
        >
          {selected === undefined ? null : <TagPreview key={selected.id} tag={selected} />}
        </SidePanel>
      ) : null}
      {renaming === undefined ? null : (
        <TagRenameForm
          key={renaming.id}
          onClose={() => {
            setRenaming(undefined);
          }}
          onMerged={(target) => {
            if (renaming.id === selectedId) {
              select(target.id);
            }
          }}
          tag={renaming}
        />
      )}
      <Confirm
        cancelLabel={t("tags.delete.cancel")}
        confirmLabel={t("tags.delete.confirm")}
        description={
          <>
            {t("tags.delete.description", { count: deleting?.bookmarkCount ?? 0 })}
            {deleteMessage === undefined ? null : (
              <span className="mt-3 block text-destructive-text" role="alert">
                {deleteMessage}
              </span>
            )}
          </>
        }
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting !== undefined) {
            remove.mutate(deleting.id);
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(undefined);
          }
        }}
        open={deleting !== undefined}
        title={t("tags.delete.title", { name: deleting?.name ?? "" })}
      />
    </div>
  );
}
