import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { BookmarkListPage } from "./BookmarkListPage.js";
import { BookmarkListSkeleton } from "./BookmarkListSkeleton.js";
import { loadBookmarkListData } from "./bookmarks-loader.js";
import { proxyRequest } from "../api/utils/proxy.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const data = await loadBookmarkListData(request);
  if (!data) {
    throw new Error("Failed to load bookmarks");
  }
  return data;
}

/** Proxy mutations (POST/PATCH/DELETE /bookmarks) to the NestJS backend. */
export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  return proxyRequest(request);
}

export function HydrateFallback() {
  return <BookmarkListSkeleton />;
}

export default function BookmarksRoute() {
  return <BookmarkListPage />;
}
