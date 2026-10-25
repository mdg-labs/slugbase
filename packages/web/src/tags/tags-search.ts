import { useNavigate, useSearch } from "@tanstack/react-router";
import { DEFAULT_TAG_SORT, TAG_SORTS, type TagSort } from "./tags.ts";

/**
 * What the address of `/tags` says about the page (doc 03 sections 3.1 and 7): the tag whose newest bookmarks are previewed,
 * by identifier, and the sort of the list, written only when it is not the default.
 */
export interface TagPageSearch {
  tag?: string;
  sort?: TagSort;
}

// A tag is addressed by its identifier, which is far shorter than this; anything longer is not one.
const TAG_PARAMETER_MAX_LENGTH = 64;

function isSort(value: unknown): value is TagSort {
  return (TAG_SORTS as readonly unknown[]).includes(value);
}

/** Reads the page parameters out of an address's search; a value that is none of the allowed ones is dropped, never an error. */
export function validateTagPageSearch(search: Record<string, unknown>): TagPageSearch {
  const result: TagPageSearch = {};
  if (typeof search.tag === "string" && search.tag !== "" && search.tag.length <= TAG_PARAMETER_MAX_LENGTH) {
    result.tag = search.tag;
  }
  if (isSort(search.sort) && search.sort !== DEFAULT_TAG_SORT) {
    result.sort = search.sort;
  }
  return result;
}

export interface TagPageControls {
  readonly tag: string | undefined;
  readonly sort: TagSort;
  /** Selects the tag, or none. Selecting is a navigation, so back returns to the tag before; clearing replaces the entry, so back does not reopen what was closed. */
  readonly select: (tag: string | undefined, options?: { readonly replace?: boolean }) => void;
  readonly setSort: (sort: TagSort) => void;
}

/** The parameters of the current address, read again through the validation, and the ways to change them. */
export function useTagPageSearch(): TagPageControls {
  const navigate = useNavigate();
  const search = validateTagPageSearch(useSearch({ from: "/_app/tags" }));
  const sort = search.sort ?? DEFAULT_TAG_SORT;
  const address = (tag: string | undefined, next: TagSort): TagPageSearch => ({
    ...(tag === undefined ? {} : { tag }),
    ...(next === DEFAULT_TAG_SORT ? {} : { sort: next }),
  });
  return {
    tag: search.tag,
    sort,
    select: (tag, options) => {
      void navigate({ to: "/tags", search: address(tag, sort), replace: options?.replace === true });
    },
    setSort: (next) => {
      void navigate({ to: "/tags", search: address(search.tag, next) });
    },
  };
}
