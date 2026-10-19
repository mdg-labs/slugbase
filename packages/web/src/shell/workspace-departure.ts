import type { QueryClient } from "@tanstack/react-query";
import type { useRouter } from "@tanstack/react-router";
import type { ApiClient } from "../api/client.ts";
import { ME_QUERY_KEY, meQuery } from "../account/me.ts";

/**
 * Moves the app on once the session no longer acts in the workspace, as when the viewer left it or it was deleted: the account is
 * read again and the app goes to the workspace the server now has it in, or to the page of an account with none. Everything that was
 * loaded for the old workspace is then loaded again.
 */
export async function leaveWorkspaceView(api: ApiClient, queryClient: QueryClient, router: ReturnType<typeof useRouter>): Promise<void> {
  let noWorkspace = false;
  try {
    const me = await queryClient.query({ ...meQuery(api), staleTime: 0 });
    noWorkspace = me.activeWorkspaceId === null;
  } catch {
    // The account could not be read again: it is dropped, so the start page asks for it afresh and decides where the account goes.
    queryClient.removeQueries({ queryKey: ME_QUERY_KEY });
  }
  await router.navigate({ to: noWorkspace ? "/no-workspace" : "/", replace: true });
  void queryClient.invalidateQueries();
  void router.invalidate();
}
