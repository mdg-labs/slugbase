import { createFileRoute } from "@tanstack/react-router";
import { TagsPage } from "../../tags/tags-page.tsx";
import { validateTagPageSearch } from "../../tags/tags-search.ts";

export const Route = createFileRoute("/_app/tags")({
  // The selected tag and the sort of the list live in the address (doc 03 section 3.1), so a link opens the page as it was.
  validateSearch: validateTagPageSearch,
  component: TagsPage,
});
