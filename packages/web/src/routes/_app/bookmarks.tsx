import { createFileRoute } from "@tanstack/react-router";
import { BookmarksPage } from "../../bookmarks/bookmarks-page.tsx";

export const Route = createFileRoute("/_app/bookmarks")({
  component: BookmarksPage,
});
