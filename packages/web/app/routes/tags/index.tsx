import type { LoaderFunctionArgs } from "react-router";

import { TagListPage } from "./TagListPage.js";
import { TagListSkeleton } from "./TagListSkeleton.js";
import { loadTagListData } from "./tags-loader.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const data = await loadTagListData(request);
  if (!data) {
    throw new Error("Failed to load tags");
  }
  return data;
}

export function HydrateFallback() {
  return <TagListSkeleton />;
}

export default function TagsRoute() {
  return <TagListPage />;
}
