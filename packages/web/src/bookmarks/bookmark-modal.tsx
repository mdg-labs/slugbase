import { Button } from "@slugbase/ui";
import { Banner, FormOverlay, Loading } from "@slugbase/ui/patterns";
import { Skeleton } from "@slugbase/ui";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearch } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { BookmarkEditor } from "./bookmark-editor.tsx";
import { bookmarkQuery, isBookmarkMissing, isSharedWithMe, type Bookmark } from "./bookmarks.ts";
import { useBookmarkModal } from "./modal-search.ts";

function CreateBookmark(): ReactElement {
  const search = useSearch({ from: "/_app" });
  const modal = useBookmarkModal();
  return <BookmarkEditor initialSlug={search.slug} initialUrl={search.url} onClose={modal.close} onEditExisting={modal.edit} />;
}

function EditBookmark({ id }: { id: string }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const modal = useBookmarkModal();
  // The form edits the bookmark as it was read when the modal opened, or when the member asked for it again after a change
  // elsewhere: a background read must not swap the version a save is made against under what the member typed.
  const query = useQuery({ ...bookmarkQuery(router.options.context.api, id), gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const [read, setRead] = useState<{ readonly bookmark: Bookmark; readonly epoch: number } | undefined>(undefined);
  if (read === undefined && query.data !== undefined) {
    setRead({ bookmark: query.data, epoch: 0 });
  }

  async function reload(): Promise<boolean> {
    const result = await query.refetch();
    if (result.isError || result.data === undefined) {
      return false;
    }
    const fresh = result.data;
    setRead((current) => ({ bookmark: fresh, epoch: (current?.epoch ?? 0) + 1 }));
    return true;
  }

  if (read !== undefined && isSharedWithMe(read.bookmark)) {
    // A share grants reading only (Q22): the bookmark of another member is not edited, whatever address opened the modal.
    return (
      <FormOverlay
        closeLabel={t("bookmarks.modal.close")}
        onOpenChange={(open) => {
          if (!open) {
            modal.close();
          }
        }}
        open
        title={t("bookmarks.modal.edit.title")}
      >
        <div className="flex flex-col gap-4">
          <Banner description={t("bookmarks.modal.shared.description")} title={t("bookmarks.modal.shared.title")} variant="info" />
          <div className="flex justify-end">
            <Button onClick={modal.close} variant="outline">
              {t("bookmarks.modal.close")}
            </Button>
          </div>
        </div>
      </FormOverlay>
    );
  }
  if (read !== undefined) {
    return <BookmarkEditor bookmark={read.bookmark} key={`${read.bookmark.id}:${String(read.epoch)}`} onClose={modal.close} onEditExisting={modal.edit} onReload={reload} />;
  }
  return (
    <FormOverlay
      closeLabel={t("bookmarks.modal.close")}
      onOpenChange={(open) => {
        if (!open) {
          modal.close();
        }
      }}
      open
      title={t("bookmarks.modal.edit.title")}
    >
      {query.isError ? (
        <div className="flex flex-col gap-4">
          {isBookmarkMissing(query.error) ? (
            <Banner description={t("bookmarks.modal.error.notFound.description")} title={t("bookmarks.modal.error.notFound.title")} variant="error" />
          ) : (
            <Banner title={t("bookmarks.modal.error.loadFailed")} variant="error" />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button onClick={modal.close} variant="outline">
              {t("bookmarks.modal.close")}
            </Button>
            {isBookmarkMissing(query.error) ? null : (
              <Button
                loading={query.isFetching}
                onClick={() => {
                  void query.refetch();
                }}
              >
                {t("bookmarks.modal.retry")}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <Loading className="p-0" label={t("bookmarks.modal.loading")}>
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-24" />
        </Loading>
      )}
    </FormOverlay>
  );
}

/**
 * The bookmark modal (doc 02 section 5.2): the one surface that creates and changes bookmarks, opened by the address
 * (`?new=1`, `?new=1&url=<url>` or `?bookmark=<id>`) over whatever page the member is on. It renders nothing when the
 * address names neither.
 */
export function BookmarkModal(): ReactElement | null {
  const search = useSearch({ from: "/_app" });
  if (search.bookmark !== undefined) {
    return <EditBookmark id={search.bookmark} key={search.bookmark} />;
  }
  if (search.new === 1) {
    return <CreateBookmark key="new" />;
  }
  return null;
}
