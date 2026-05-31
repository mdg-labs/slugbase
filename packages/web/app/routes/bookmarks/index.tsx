import type { LoaderFunctionArgs } from "react-router";

import { BookmarkListPage } from "./BookmarkListPage.js";
import { loadBookmarkListData } from "./bookmarks-loader.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const data = await loadBookmarkListData(request);
  if (!data) {
    throw new Error("Failed to load bookmarks");
  }
  return data;
}

export default function BookmarksRoute() {
  return <BookmarkListPage />;
}
