import { Button } from "@slugbase/ui";
import { MultiPick } from "@slugbase/ui/patterns";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { folderIconOf, folderTextClass } from "../folders/folder-glyph.tsx";
import {
  DEFAULT_FOLDER_SORT,
  FOLDERS_QUERY_KEY,
  FOLDER_DEFAULT_COLOR,
  FOLDER_DEFAULT_ICON,
  FOLDER_NAME_MAX_LENGTH,
  createFolder,
  folderFailureOf,
  folderListQuery,
  type Folder,
  type FolderFailure,
} from "../folders/folders.ts";
import { inPlaceRefusals } from "../shell/mutation-error-toasts.tsx";
import { rateLimitMessage } from "./rate-limit-message.ts";

/** The key of the mutation that makes a folder from the modal, which the modal reads to hold its own save until it is done. */
export const CREATE_FOLDER_MUTATION_KEY = ["bookmarks", "create-folder"] as const;

// The refusals `folderFailureOf` tells under the field, for which the shared error toast stays quiet; any other failure still raises it.
const SHOWN_UNDER_THE_FIELD = inPlaceRefusals([{ status: 409, code: "name_taken" }, { status: 422 }, { status: 429, code: "rate_limited" }]);

const NAME_TOO_LONG: FolderFailure = { kind: "invalidName" };

/** A folder as the modal knows it: what the bookmark carries, and what the list and a creation answer. */
export interface FolderChoice {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly color: number;
}

export interface FolderPickProps {
  /** The identifiers of the folders chosen, in the order of the chips. */
  readonly value: readonly string[];
  /** The folders the bookmark is in already, which have their chips before the list is read. */
  readonly known: readonly FolderChoice[];
  readonly onChange: (ids: string[]) => void;
  /** A folder made from the field; it is chosen by the caller, not by the field. */
  readonly onCreated: (folder: FolderChoice) => void;
  readonly disabled: boolean;
}

function failureMessage(t: TFunction, failure: FolderFailure): string | undefined {
  switch (failure.kind) {
    case "nameTaken":
      return t("bookmarks.modal.folders.error.taken");
    case "invalidName":
      return t("bookmarks.modal.folders.error.invalid", { max: FOLDER_NAME_MAX_LENGTH });
    case "rateLimited":
      return rateLimitMessage(t, failure.seconds);
    default:
      // Any other failure of the creation is reported by the shared error toast.
      return undefined;
  }
}

/**
 * The folders field of the bookmark modal (doc 03 section 4): a `multi-pick` of the member's folders with a "Create
 * folder" item that makes the folder through the same request as the Folders page and then offers it as chosen. A folder
 * that could not be made is told under the field and chooses nothing; a list that could not be read is told as such and
 * can be read again, never shown as having no folders.
 */
export function FolderPick({ value, known, onChange, onCreated, disabled }: FolderPickProps): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const list = useInfiniteQuery(folderListQuery(api, DEFAULT_FOLDER_SORT));
  const [made, setMade] = useState<readonly FolderChoice[]>([]);
  const [failure, setFailure] = useState<FolderFailure | undefined>(undefined);

  // The field searches the whole list, so a list of more than one page is read to its end.
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = list;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  const create = useMutation({
    mutationKey: CREATE_FOLDER_MUTATION_KEY,
    meta: SHOWN_UNDER_THE_FIELD,
    mutationFn: (name: string): Promise<Folder> => createFolder(api, { name, icon: FOLDER_DEFAULT_ICON, color: FOLDER_DEFAULT_COLOR }),
    onSuccess: (folder) => {
      void queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
      setMade((current) => [...current, folder]);
      setFailure(undefined);
      onCreated(folder);
    },
    onError: (error) => {
      const next = folderFailureOf(error);
      setFailure(next);
      // A name the member already has that the list does not show is a list that is out of date.
      if (next?.kind === "nameTaken") {
        void queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
      }
    },
  });

  const listed = list.data?.pages.flatMap((page) => page.items) ?? [];
  const byId = new Map<string, FolderChoice>([...known, ...made, ...listed].map((folder) => [folder.id, folder]));
  const options = [...byId.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((folder) => {
      const Icon = folderIconOf(folder.icon);
      return { value: folder.id, label: folder.name, icon: <Icon className={`size-4 ${folderTextClass(folder.color)}`} /> };
    });
  const loading = !list.isError && (list.isPending || list.hasNextPage);
  const problem = failure === undefined ? undefined : failureMessage(t, failure);

  return (
    <MultiPick
      creatable={{
        label: (name) => t("bookmarks.modal.folders.create", { name }),
        onCreate: (name) => {
          if (create.isPending) {
            return;
          }
          if (name.length > FOLDER_NAME_MAX_LENGTH) {
            setFailure(NAME_TOO_LONG);
            return;
          }
          setFailure(undefined);
          create.mutate(name);
        },
      }}
      description={
        list.isError ? (
          <span className="flex flex-wrap items-center gap-x-2">
            {t("bookmarks.modal.folders.loadFailed")}
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
      emptyLabel={t("bookmarks.modal.folders.empty")}
      error={problem}
      label={t("bookmarks.modal.folders.label")}
      loadingLabel={loading ? t("bookmarks.modal.folders.loading") : undefined}
      onValueChange={(ids) => {
        setFailure(undefined);
        onChange(ids);
      }}
      options={options}
      placeholder={t("bookmarks.modal.folders.placeholder")}
      removeLabel={(name) => t("bookmarks.modal.folders.remove", { name })}
      unavailableLabel={list.isError ? t("bookmarks.modal.folders.loadFailed") : undefined}
      value={value}
    />
  );
}
