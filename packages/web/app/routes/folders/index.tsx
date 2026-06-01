import type { LoaderFunctionArgs } from "react-router";

import { FolderListPage } from "./FolderListPage.js";
import { FolderListSkeleton } from "./FolderListSkeleton.js";
import { loadFolderListData } from "./folders-loader.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const data = await loadFolderListData(request);
  if (!data) {
    throw new Error("Failed to load folders");
  }
  return data;
}

export function HydrateFallback() {
  return <FolderListSkeleton />;
}

export default function FoldersRoute() {
  return <FolderListPage />;
}
