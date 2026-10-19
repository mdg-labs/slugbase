import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireAccount } from "../account/require-account.ts";
import { AppLayout } from "../shell/app-layout.tsx";

// The pages about the account itself are open to an account with no workspace to act in.
const ACCOUNT_PATH = "/settings/account";

function isAccountPage(pathname: string): boolean {
  return pathname === ACCOUNT_PATH || pathname.startsWith(`${ACCOUNT_PATH}/`);
}

export const Route = createFileRoute("/_app")({
  // Every page of the app needs a session (see `requireAccount`). An account that acts in no workspace has
  // nothing to show on the pages of a workspace: it is sent to the page that says what to do about that.
  beforeLoad: async ({ context, location }) => {
    const me = await requireAccount({ context, location });
    if (me?.activeWorkspaceId === null && !isAccountPage(location.pathname)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/no-workspace", replace: true });
    }
  },
  component: AppLayout,
});
