import { BOOKMARK_BULK_TAGS_MAX } from "@slugbase/contracts";
import { Button } from "@slugbase/ui";
import { FormOverlay, MultiPick, Picker } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { folderIconOf, folderTextClass } from "../folders/folder-glyph.tsx";
import { useAllFolders } from "../folders/use-all-folders.ts";
import { useAllTags } from "../tags/use-all-tags.ts";
import { BOOKMARKS_QUERY_KEY, previewAddTags, type BulkAction, type BulkTarget } from "./bookmarks.ts";

/** The actions of the bar that name a folder or tags. */
export type LinkAction = Extract<BulkAction, "add_to_folder" | "remove_from_folder" | "add_tags" | "remove_tags">;

export interface BulkLinkOverlayProps {
  readonly action: LinkAction;
  /** The bookmarks the action is for; the count in the title is the count it acts on. */
  readonly ids: readonly string[];
  /** Called with the folder or tags chosen; the caller runs the action and closes the overlay. */
  readonly onSubmit: (target: BulkTarget) => void;
  readonly onClose: () => void;
}

interface Retryable {
  readonly status: "loading" | "ready" | "failed";
  readonly retrying: boolean;
  readonly retry: () => void;
}

/** What the member chooses for a bulk folder or tag action (doc 03 section 3.4): a folder, or tags with the preview of the merged set for adding. */
export function BulkLinkOverlay({ action, ids, onSubmit, onClose }: BulkLinkOverlayProps): ReactElement {
  const { t } = useTranslation();
  const count = ids.length;
  const title =
    action === "add_to_folder"
      ? t("bookmarks.bulk.link.title.addToFolder", { count })
      : action === "remove_from_folder"
        ? t("bookmarks.bulk.link.title.removeFromFolder", { count })
        : action === "add_tags"
          ? t("bookmarks.bulk.link.title.addTags", { count })
          : t("bookmarks.bulk.link.title.removeTags", { count });
  return (
    <FormOverlay
      closeLabel={t("bookmarks.bulk.link.close")}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={title}
    >
      {action === "add_to_folder" || action === "remove_from_folder" ? (
        <FolderChoice action={action} onClose={onClose} onSubmit={onSubmit} />
      ) : (
        <TagsChoice action={action} ids={ids} onClose={onClose} onSubmit={onSubmit} />
      )}
    </FormOverlay>
  );
}

function submitLabel(t: TFunction, action: LinkAction): string {
  switch (action) {
    case "add_to_folder":
      return t("bookmarks.bulk.addToFolder");
    case "remove_from_folder":
      return t("bookmarks.bulk.removeFromFolder");
    case "add_tags":
      return t("bookmarks.bulk.addTags");
    case "remove_tags":
      return t("bookmarks.bulk.removeTags");
  }
}

function retryNote(message: string, list: Retryable, label: string): ReactNode {
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      {message}
      <Button loading={list.retrying} onClick={list.retry} size="xs" type="button" variant="outline">
        {label}
      </Button>
    </span>
  );
}

function Actions({ action, canSubmit, onClose }: { readonly action: LinkAction; readonly canSubmit: boolean; readonly onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button onClick={onClose} type="button" variant="outline">
        {t("bookmarks.bulk.link.cancel")}
      </Button>
      <Button disabled={!canSubmit} type="submit">
        {submitLabel(t, action)}
      </Button>
    </div>
  );
}

function FolderChoice({ action, onClose, onSubmit }: Pick<BulkLinkOverlayProps, "onClose" | "onSubmit"> & { readonly action: LinkAction }): ReactElement {
  const { t } = useTranslation();
  const list = useAllFolders();
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const options = [...list.folders]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((folder) => {
      const Icon = folderIconOf(folder.icon);
      return { value: folder.id, label: folder.name, icon: <Icon className={`size-4 ${folderTextClass(folder.color)}`} /> };
    });
  const folder = list.folders.find(({ id }) => id === chosen);
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (folder !== undefined) {
      onSubmit({ folder: { id: folder.id, name: folder.name, icon: folder.icon, color: folder.color } });
    }
  };
  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
      <Picker
        description={list.status === "failed" ? retryNote(t("bookmarks.bulk.link.folder.loadFailed"), list, t("bookmarks.bulk.link.retry")) : undefined}
        emptyLabel={t("bookmarks.bulk.link.folder.empty")}
        label={t("bookmarks.bulk.link.folder.label")}
        {...(list.status === "loading" ? { loadingLabel: t("bookmarks.bulk.link.folder.loading") } : {})}
        {...(list.status === "failed" ? { unavailableLabel: t("bookmarks.bulk.link.folder.loadFailed") } : {})}
        onValueChange={setChosen}
        options={options}
        placeholder={t("bookmarks.bulk.link.folder.placeholder")}
        value={chosen}
      />
      <Actions action={action} canSubmit={folder !== undefined} onClose={onClose} />
    </form>
  );
}

function TagsChoice({ action, ids, onClose, onSubmit }: Pick<BulkLinkOverlayProps, "ids" | "onClose" | "onSubmit"> & { readonly action: LinkAction }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const list = useAllTags();
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const adding = action === "add_tags";
  const options = [...list.tags].sort((a, b) => a.name.localeCompare(b.name)).map((tag) => ({ value: tag.id, label: tag.name }));
  const tags = list.tags.filter(({ id }) => chosen.includes(id)).map(({ id, name }) => ({ id, name }));
  // Adding shows what the bookmarks will carry first; the button waits for that answer to be the one for these tags.
  const preview = useQuery({
    queryKey: [...BOOKMARKS_QUERY_KEY, "bulk-preview", ids, chosen],
    queryFn: ({ signal }) => previewAddTags(router.options.context.api, ids, chosen, signal),
    enabled: adding && chosen.length > 0,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const previewed = preview.data;
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (tags.length > 0) {
      onSubmit({ tags });
    }
  };
  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
      <MultiPick
        description={
          list.status === "failed"
            ? retryNote(t("bookmarks.bulk.link.tags.loadFailed"), list, t("bookmarks.bulk.link.retry"))
            : t("bookmarks.bulk.link.tags.limit", { max: BOOKMARK_BULK_TAGS_MAX })
        }
        emptyLabel={t("bookmarks.bulk.link.tags.empty")}
        label={t("bookmarks.bulk.link.tags.label")}
        {...(list.status === "loading" ? { loadingLabel: t("bookmarks.bulk.link.tags.loading") } : {})}
        {...(list.status === "failed" ? { unavailableLabel: t("bookmarks.bulk.link.tags.loadFailed") } : {})}
        onValueChange={(next) => {
          setChosen(next.slice(0, BOOKMARK_BULK_TAGS_MAX));
        }}
        options={options}
        placeholder={t("bookmarks.bulk.link.tags.placeholder")}
        removeLabel={(name) => t("bookmarks.bulk.link.tags.remove", { name })}
        value={chosen}
      />
      {adding && chosen.length > 0 ? (
        <section aria-label={t("bookmarks.bulk.link.preview.title")} className="flex flex-col gap-2 rounded-lg border bg-muted/48 p-3 text-sm" data-slot="bulk-tag-preview">
          <h3 className="font-medium">{t("bookmarks.bulk.link.preview.title")}</h3>
          {preview.isError ? (
            <div className="flex flex-wrap items-center gap-x-2 text-destructive-text" role="alert">
              {t("bookmarks.bulk.link.preview.error")}
              <Button loading={preview.isFetching} onClick={() => void preview.refetch()} size="xs" type="button" variant="outline">
                {t("bookmarks.bulk.link.retry")}
              </Button>
            </div>
          ) : previewed === undefined ? (
            <p className="text-muted-foreground" role="status">
              {t("bookmarks.bulk.link.preview.loading")}
            </p>
          ) : (
            <>
              <p>{t("bookmarks.bulk.link.preview.summary", { count: previewed.affected })}</p>
              {previewed.skipped === 0 ? null : <p className="text-muted-foreground">{t("bookmarks.bulk.link.preview.skipped", { count: previewed.skipped })}</p>}
              <ul className="flex flex-col gap-1">
                {previewed.tags.map((tag) => (
                  <li className="flex flex-wrap justify-between gap-x-3" key={tag.id}>
                    <span className="min-w-0 wrap-anywhere font-medium">{tag.name}</span>
                    <span className="text-muted-foreground">{t("bookmarks.bulk.link.preview.tagCount", { bookmarkCount: tag.bookmarkCount, added: tag.added })}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : null}
      <Actions action={action} canSubmit={tags.length > 0 && (!adding || (previewed !== undefined && previewed.affected > 0))} onClose={onClose} />
    </form>
  );
}
