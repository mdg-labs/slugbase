import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { FolderListPage } from "./FolderListPage.js";
import { FolderListSkeleton } from "./FolderListSkeleton.js";
import { loadFolderListData } from "./folders-loader.js";
import { proxyRequest } from "../api/utils/proxy.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const data = await loadFolderListData(request);
  if (!data) {
    throw new Error("Failed to load folders");
  }
  return data;
}

/** Proxy mutations (POST/PATCH/DELETE /folders) to the NestJS backend. */
export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  return proxyRequest(request);
}

export function HydrateFallback() {
  return <FolderListSkeleton />;
}

export default function FoldersRoute() {
  return <FolderListPage />;
}
