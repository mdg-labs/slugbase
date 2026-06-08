import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { TagListPage } from "./TagListPage.js";
import { TagListSkeleton } from "./TagListSkeleton.js";
import { loadTagListData } from "./tags-loader.js";
import { proxyRequest } from "../api/utils/proxy.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const data = await loadTagListData(request);
  if (!data) {
    throw new Error("Failed to load tags");
  }
  return data;
}

/** Proxy mutations (POST/PATCH/DELETE /tags) to the NestJS backend. */
export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  return proxyRequest(request);
}

export function HydrateFallback() {
  return <TagListSkeleton />;
}

export default function TagsRoute() {
  return <TagListPage />;
}
