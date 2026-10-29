import { Button, Skeleton, useShortcut } from "@slugbase/ui";
import { Banner, Confirm, EmptyState, FolderIcon, Loading, LoadMore, PlusIcon, SelectField } from "@slugbase/ui/patterns";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../i18n/use-format.ts";
import { ShareDialog, type ShareSubject } from "../sharing/index.ts";
import { FolderForm, type FolderFormIntent } from "./folder-form.tsx";
import { FOLDER_SORTS, folderFailureOf, folderListQuery, type Folder, type FolderSort } from "./folders.ts";
import { useCreateFolderForm, useFolderSort } from "./folders-search.ts";
import { FoldersTable } from "./folders-table.tsx";
import { useDeleteFolder } from "./use-delete-folder.ts";

// The shell's main area has no padding of its own: each page keeps its content off the edges, as the settings and admin layouts do.
const PAGE_FRAME = "flex w-full min-w-0 flex-col gap-4 p-4 md:p-6";

const CREATE: FolderFormIntent = "create";

const SKELETON_ROWS = ["a", "b", "c", "d"] as const;

function isSort(value: string): value is FolderSort {
  return (FOLDER_SORTS as readonly string[]).includes(value);
}

interface Editing {
  readonly intent: FolderFormIntent;
  readonly folder?: Folder;
}

/**
 * `/folders` (doc 03 section 6): the member's folders under the sort the address holds, each with its icon, colour, name
 * and bookmark count, and the forms that create, rename and restyle a folder and the confirmation that deletes one. `N`
 * opens the form for a new folder, as `?create=1` does. The Mine and Shared with me scopes are not offered yet. The row action Share settings opens the share dialog of an own folder.
 */
export function FoldersPage(): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const { sort, setSort } = useFolderSort();
  const query = useInfiniteQuery(folderListQuery(router.options.context.api, sort));
  const createForm = useCreateFolderForm();
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [deleting, setDeleting] = useState<Folder | undefined>(undefined);
  const [sharing, setSharing] = useState<ShareSubject | undefined>(undefined);
  const remove = useDeleteFolder(() => {
    setDeleting(undefined);
  });

  const startCreate = createForm.open;
  const startRename = (folder: Folder): void => {
    setEditing({ intent: "rename", folder });
  };
  const startRestyle = (folder: Folder): void => {
    setEditing({ intent: "style", folder });
  };
  const startShare = (folder: Folder): void => {
    setSharing({ kind: "folder", id: folder.id, name: folder.name });
  };
  const startDelete = (folder: Folder): void => {
    remove.reset();
    setDeleting(folder);
  };
  useShortcut({ key: "n" }, (event) => {
    event.preventDefault();
    startCreate();
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const lastPage = query.data?.pages.at(-1);
  const newFolder = (
    <Button onClick={startCreate}>
      <PlusIcon aria-hidden="true" />
      {t("folders.new")}
    </Button>
  );
  const heading = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="font-semibold text-2xl leading-none">{t("folders.page.title")}</h1>
      {newFolder}
    </div>
  );
  const retry = (
    <Button
      loading={query.isFetching}
      onClick={() => {
        void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch());
      }}
      size="sm"
      variant="outline"
    >
      {t("folders.list.retry")}
    </Button>
  );

  let body: ReactElement;
  if (query.isPending) {
    body = (
      <Loading className="p-0" label={t("folders.list.loading")}>
        <div className="flex flex-col gap-2">
          {SKELETON_ROWS.map((key) => (
            <Skeleton className="h-12 rounded-lg" key={key} />
          ))}
        </div>
      </Loading>
    );
  } else if (query.data === undefined) {
    body = <Banner action={retry} title={t("folders.list.loadFailed")} variant="error" />;
  } else if (items.length === 0 && !query.hasNextPage) {
    body = (
      <EmptyState
        actions={newFolder}
        description={t("folders.list.empty.description")}
        headingLevel={2}
        icon={<FolderIcon aria-hidden="true" />}
        title={t("folders.list.empty.title")}
      />
    );
  } else {
    const shown = format.number(items.length);
    body = (
      <>
        {query.isError ? <Banner action={retry} title={query.isFetchNextPageError ? t("folders.list.loadMoreFailed") : t("folders.list.refreshFailed")} variant="error" /> : null}
        <FoldersTable
          folders={items}
          onDelete={startDelete}
          onRename={startRename}
          onRestyle={startRestyle}
          onShare={startShare}
        />
        <LoadMore
          count={
            lastPage?.totalAtLeast !== undefined && lastPage.total === null
              ? t("folders.list.countAtLeast", { shown, total: format.number(lastPage.totalAtLeast) })
              : t("folders.list.count", { shown, total: format.number(lastPage?.total ?? items.length) })
          }
          hasMore={query.hasNextPage}
          loadMoreLabel={t("folders.list.loadMore")}
          loading={query.isFetchingNextPage}
          onLoadMore={() => {
            void query.fetchNextPage();
          }}
        />
      </>
    );
  }

  const sortOptions = [
    { value: "name", label: t("folders.sort.name") },
    { value: "count", label: t("folders.sort.count") },
    { value: "updated", label: t("folders.sort.updated") },
  ] as const satisfies readonly { value: FolderSort; label: string }[];
  const showSort = query.data === undefined || items.length > 0 || query.hasNextPage;

  return (
    <div className={PAGE_FRAME}>
      {heading}
      {showSort ? (
        <SelectField
          className="sm:w-56"
          label={t("folders.sort.label")}
          onValueChange={(value) => {
            if (isSort(value)) {
              setSort(value);
            }
          }}
          options={sortOptions}
          value={sort}
        />
      ) : null}
      {body}
      {editing === undefined ? null : (
        <FolderForm
          folder={editing.folder}
          intent={editing.intent}
          key={`${editing.intent}:${editing.folder?.id ?? "new"}`}
          onClose={() => {
            setEditing(undefined);
          }}
        />
      )}
      {createForm.creating ? <FolderForm intent={CREATE} key={CREATE} onClose={createForm.close} /> : null}
      <Confirm
        cancelLabel={t("folders.delete.cancel")}
        confirmLabel={t("folders.delete.confirm")}
        description={
          <>
            {t("folders.delete.description", { count: deleting?.bookmarkCount ?? 0 })}
            {remove.isError ? (
              <span className="mt-3 block text-destructive-text" role="alert">
                {folderFailureOf(remove.error)?.kind === "notFound" ? t("folders.delete.error.notFound") : t("folders.delete.error.unavailable")}
              </span>
            ) : null}
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
        title={t("folders.delete.title", { name: deleting?.name ?? "" })}
      />
      {sharing === undefined ? null : (
        <ShareDialog
          onClose={() => {
            setSharing(undefined);
          }}
          subject={sharing}
        />
      )}
    </div>
  );
}
