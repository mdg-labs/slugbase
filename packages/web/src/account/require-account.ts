import { redirect } from "@tanstack/react-router";
import { isSessionEnded } from "../api/client.ts";
import { isMfaRequired, mfaPath } from "../auth/mfa.ts";
import { sessionQuery } from "../auth/session.ts";
import { isSetupRequired } from "../config/setup-state.ts";
import type { RouterContext } from "../router-context.ts";
import { meQuery, type Me } from "./me.ts";

/**
 * What a page for a signed-in account asks before it renders. A visitor without a session is sent to sign in, and
 * comes back to the page they asked for; a check that fails for any other reason is not a signed-in visitor either,
 * so the error page shows instead of the page. While the instance has no account there is no session to check and
 * nobody to sign in: the visitor is sent to set it up.
 *
 * The account carries the preferences that shape the first render: language, theme, accent, shortcuts. It is not a
 * gate: when it cannot be loaded the interface keeps what the browser remembers, the answer is undefined, and the
 * pages that need the account ask again and show their own failure.
 */
export async function requireAccount({
  context,
  location,
}: {
  context: RouterContext;
  location: { href: string };
}): Promise<Me | undefined> {
  if (isSetupRequired(context.queryClient)) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
    throw redirect({ to: "/setup", replace: true });
  }
  try {
    await context.queryClient.query({ ...sessionQuery(context.api), staleTime: "static" });
  } catch (error) {
    if (isMfaRequired(error)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ href: mfaPath(location.href), replace: true });
    }
    if (isSessionEnded(error)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/login", search: { next: location.href }, replace: true });
    }
    throw error;
  }
  try {
    return await context.queryClient.query({ ...meQuery(context.api), retry: false, staleTime: "static" });
  } catch (error) {
    if (isSessionEnded(error)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/login", search: { next: location.href }, replace: true });
    }
    return undefined;
  }
}
