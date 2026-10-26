import { useNavigate } from "@tanstack/react-router";

/**
 * What the address says about the bookmark modal (doc 02 section 5.2): `?new=1`, optionally with the `url` and the `slug` to prefill,
 * opens it empty, and `?bookmark=<id>` opens it on that bookmark. The modal has no route of its own, so any page of
 * the app can open it and closing it leaves the page where it was.
 */
export interface BookmarkModalSearch {
  new?: 1;
  url?: string;
  slug?: string;
  bookmark?: string;
}

/** Reads the modal's parameters out of an address's search; anything else in it is left to the page. */
export function validateBookmarkModalSearch(search: Record<string, unknown>): BookmarkModalSearch {
  const result: BookmarkModalSearch = {};
  // The router parses `1` into a number; a hand-written `true` or "1" is as good.
  if (search.new === 1 || search.new === "1" || search.new === true) {
    result.new = 1;
  }
  if (typeof search.url === "string" && search.url !== "") {
    result.url = search.url;
  }
  if (typeof search.slug === "string" && search.slug !== "") {
    result.slug = search.slug;
  }
  if (typeof search.bookmark === "string" && search.bookmark !== "") {
    result.bookmark = search.bookmark;
  }
  return result;
}

const MODAL_KEYS: ReadonlySet<string> = new Set(["new", "url", "slug", "bookmark"]);

export interface BookmarkModalControls {
  /** Opens the modal for a new bookmark, with the address prefilled where there is one. */
  openNew: (url?: string) => void;
  /** Opens the modal on a bookmark. */
  edit: (id: string) => void;
  /** Closes the modal and leaves the rest of the address as it is. */
  close: () => void;
}

/** The ways to open and close the bookmark modal from anywhere in the app. */
export function useBookmarkModal(): BookmarkModalControls {
  const navigate = useNavigate();
  function go(next: BookmarkModalSearch): void {
    void navigate({
      to: ".",
      search: (previous) => {
        const rest = Object.fromEntries(Object.entries(previous).filter(([key]) => !MODAL_KEYS.has(key)));
        return { ...rest, ...next };
      },
    });
  }
  return {
    openNew: (url) => {
      go({ new: 1, ...(url === undefined ? {} : { url }) });
    },
    edit: (id) => {
      go({ bookmark: id });
    },
    close: () => {
      go({});
    },
  };
}
