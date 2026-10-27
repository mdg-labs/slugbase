import { useNavigate, useSearch } from "@tanstack/react-router";
import { DEFAULT_FOLDER_SORT, FOLDER_SORTS, type FolderSort } from "./folders.ts";

/** What the address of `/folders` says about the list: the sort, written only when it is not the default, and `create` while the form for a new folder is asked for. */
export interface FolderListSearch {
  sort?: FolderSort;
  create?: 1;
}

function isSort(value: unknown): value is FolderSort {
  return (FOLDER_SORTS as readonly unknown[]).includes(value);
}

/** Reads the list parameters out of an address's search; a value that is none of the allowed ones is dropped, never an error. */
export function validateFolderListSearch(search: Record<string, unknown>): FolderListSearch {
  const result: FolderListSearch = {};
  if (isSort(search.sort) && search.sort !== DEFAULT_FOLDER_SORT) {
    result.sort = search.sort;
  }
  // The router parses `1` into a number; a hand-written `true` or "1" is as good.
  if (search.create === 1 || search.create === "1" || search.create === true) {
    result.create = 1;
  }
  return result;
}

/** The sort of the current address and the way to change it as a navigation, so back returns to the list as it was. */
export function useFolderSort(): { readonly sort: FolderSort; readonly setSort: (sort: FolderSort) => void } {
  const navigate = useNavigate();
  const search = validateFolderListSearch(useSearch({ from: "/_app/folders" }));
  return {
    sort: search.sort ?? DEFAULT_FOLDER_SORT,
    setSort: (sort) => {
      void navigate({ to: ".", search: sort === DEFAULT_FOLDER_SORT ? {} : { sort } });
    },
  };
}

/** Whether the address asks for the create form, and the ways to open and close it as a navigation that keeps the sort. */
export function useCreateFolderForm(): { readonly creating: boolean; readonly open: () => void; readonly close: () => void } {
  const navigate = useNavigate();
  const search = validateFolderListSearch(useSearch({ from: "/_app/folders" }));
  return {
    creating: search.create === 1,
    open: () => {
      void navigate({ to: ".", search: (previous) => ({ ...previous, create: 1 }) });
    },
    close: () => {
      void navigate({ to: ".", search: (previous) => ({ ...previous, create: undefined }) });
    },
  };
}
