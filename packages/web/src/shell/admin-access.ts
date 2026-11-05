import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { ME_QUERY_KEY, meQuery } from "../account/me.ts";
import { ApiProblemError } from "../api/client.ts";

/**
 * Whether the admin pages may read what an admin without a second factor may read (the status, the settings, the workspace list
 * and workspace creation, the test email): the account is an instance admin. An account that is not loaded is not an admin.
 */
export function useAdminReadEnabled(): boolean {
  const router = useRouter();
  const me = useQuery(meQuery(router.options.context.api));
  return me.data?.account.isInstanceAdmin === true;
}

/**
 * Whether the admin pages may do what the server refuses an admin without a second factor (changing the settings, adding
 * oneself to a workspace, inviting an owner, deleting a workspace, and everything about accounts): the account is an instance
 * admin and has a second factor. A page asks for nothing and offers no such action while this is false.
 */
export function useAdminActionsEnabled(): boolean {
  const router = useRouter();
  const me = useQuery(meQuery(router.options.context.api));
  return me.data?.account.isInstanceAdmin === true && me.data.account.mfaEnabled;
}

/**
 * Makes the app read the account again when an admin request was refused with a 403: the account may have lost the flag meanwhile
 * (its own demotion, or another admin's), and the layout then shows the 403 page instead of a page that asks for what it may not.
 */
export function useRefreshStandingOnForbidden(error: unknown): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (error instanceof ApiProblemError && error.status === 403) {
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    }
  }, [error, queryClient]);
}
