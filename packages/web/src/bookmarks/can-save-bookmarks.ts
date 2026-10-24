import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { meQuery } from "../account/me.ts";

/** Whether the account acts in a workspace to save bookmarks to; one that acts in none has no way to create a bookmark. */
export function useCanSaveBookmarks(): boolean {
  const router = useRouter();
  const me = useQuery({ ...meQuery(router.options.context.api), staleTime: Number.POSITIVE_INFINITY });
  return me.data?.activeWorkspaceId !== null;
}
