import { useNavigate, useSearch } from "@tanstack/react-router";
import { DEFAULT_FOLDER_SORT, FOLDER_SORTS, type FolderSort } from "./folders.ts";

/** What the address of `/folders` says about the list: the sort, written only when it is not the default. */
export interface FolderListSearch {
  sort?: FolderSort;
}

function isSort(value: unknown): value is FolderSort {
  return (FOLDER_SORTS as readonly unknown[]).includes(value);
}

/** Reads the list parameters out of an address's search; a value that is none of the allowed ones is dropped, never an error. */
export function validateFolderListSearch(search: Record<string, unknown>): FolderListSearch {
  return isSort(search.sort) && search.sort !== DEFAULT_FOLDER_SORT ? { sort: search.sort } : {};
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
