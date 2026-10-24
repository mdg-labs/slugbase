import { createFileRoute } from "@tanstack/react-router";
import { BookmarksPage } from "../../bookmarks/bookmarks-page.tsx";
import { validateBookmarkListSearch } from "../../bookmarks/list-search.ts";

export const Route = createFileRoute("/_app/bookmarks")({
  // The filters, sort, view and size of the list live in the address (doc 03 section 3.1), next to the bookmark modal's parameters the layout reads.
  validateSearch: validateBookmarkListSearch,
  component: BookmarksPage,
});
