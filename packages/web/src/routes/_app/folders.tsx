import { createFileRoute } from "@tanstack/react-router";
import { FoldersPage } from "../../folders/folders-page.tsx";
import { validateFolderListSearch } from "../../folders/folders-search.ts";

export const Route = createFileRoute("/_app/folders")({
  // The sort of the list lives in the address (doc 03 section 3.1), so a link opens the list as it was.
  validateSearch: validateFolderListSearch,
  component: FoldersPage,
});
