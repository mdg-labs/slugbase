import { Button } from "@slugbase/ui";
import { MultiPick } from "@slugbase/ui/patterns";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { TAG_NAME_MAX_LENGTH, tagListQuery } from "../tags/tags.ts";
import { splitTagValues, tagValuesOf } from "./bookmark-choices.ts";

/** A tag as the modal knows it: what the bookmark carries and what the list answers. */
export interface TagChoice {
  readonly id: string;
  readonly name: string;
}

export interface TagPickProps {
  /** The identifiers of the tags chosen. */
  readonly ids: readonly string[];
  /** The names chosen that the member has no tag of yet; the API makes the tags when the bookmark is saved. */
  readonly names: readonly string[];
  /** The tags the bookmark carries already, which have their chips before the list is read. */
  readonly known: readonly TagChoice[];
  readonly onChange: (ids: string[], names: string[]) => void;
  /** A name was typed that no tag can have. */
  readonly onTooLong: () => void;
  readonly error: string | undefined;
  readonly disabled: boolean;
}

/**
 * The tags field of the bookmark modal (doc 03 section 4): a creatable `multi-pick` of the member's tags. A name that is
 * none of theirs is a chip of its own, sent as `tagNames` with the save; it is made with the bookmark, so a save that fails
 * leaves nothing behind. A name longer than a tag may be is refused at the field. A list that could not be read is told as
 * such and can be read again, never shown as having no tags; names can still be added.
 */
export function TagPick({ ids, names, known, onChange, onTooLong, error, disabled }: TagPickProps): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const list = useInfiniteQuery(tagListQuery(router.options.context.api));

  // The field searches the whole list, so a list of more than one page is read to its end.
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = list;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  const listed = list.data?.pages.flatMap((page) => page.items) ?? [];
  const byId = new Map<string, TagChoice>([...known, ...listed].map((tag) => [tag.id, tag]));
  const options = [
    ...[...byId.values()].sort((a, b) => a.name.localeCompare(b.name)).map((tag) => ({ value: tag.id, label: tag.name })),
    ...tagValuesOf([], names).map((value, index) => ({ value, label: names[index] ?? value })),
  ];
  const loading = !list.isError && (list.isPending || list.hasNextPage);

  return (
    <MultiPick
      creatable={{
        label: (name) => t("bookmarks.modal.tags.create", { name }),
        onCreate: (name) => {
          if (name.length > TAG_NAME_MAX_LENGTH) {
            onTooLong();
            return;
          }
          onChange([...ids], [...names, name]);
        },
      }}
      description={
        list.isError ? (
          <span className="flex flex-wrap items-center gap-x-2">
            {t("bookmarks.modal.tags.loadFailed")}
            <Button
              loading={list.isFetching}
              onClick={() => {
                void list.refetch();
              }}
              size="xs"
              type="button"
              variant="outline"
            >
              {t("bookmarks.modal.retry")}
            </Button>
          </span>
        ) : undefined
      }
      disabled={disabled}
      emptyLabel={t("bookmarks.modal.tags.empty")}
      error={error}
      label={t("bookmarks.modal.tags.label")}
      loadingLabel={loading ? t("bookmarks.modal.tags.loading") : undefined}
      onValueChange={(values) => {
        const next = splitTagValues(values);
        onChange(next.ids, next.names);
      }}
      options={options}
      placeholder={t("bookmarks.modal.tags.placeholder")}
      removeLabel={(name) => t("bookmarks.modal.tags.remove", { name })}
      unavailableLabel={list.isError ? t("bookmarks.modal.tags.loadFailed") : undefined}
      value={tagValuesOf(ids, names)}
    />
  );
}
