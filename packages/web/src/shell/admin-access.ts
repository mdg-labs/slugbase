import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { meQuery } from "../account/me.ts";

/**
 * Whether the admin pages may act: the account is an instance admin and has a second factor. The server refuses
 * an admin without one, so a page asks for nothing and offers no action while this is false; an account that is
 * not loaded is not an admin.
 */
export function useAdminActionsEnabled(): boolean {
  const router = useRouter();
  const me = useQuery(meQuery(router.options.context.api));
  return me.data?.account.isInstanceAdmin === true && me.data.account.mfaEnabled;
}
