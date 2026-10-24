import { createFileRoute, redirect } from "@tanstack/react-router";
import { validateBookmarkModalSearch } from "../bookmarks/modal-search.ts";
import { requireAccount } from "../account/require-account.ts";
import { AppLayout } from "../shell/app-layout.tsx";

// The pages about the account itself and the instance admin pages are open to an account with no workspace to act
// in: neither is a page of a workspace. The admin layout decides for itself who may see its pages.
const WORKSPACE_FREE_PATHS = ["/settings/account", "/admin"];

function isWorkspaceFreePage(pathname: string): boolean {
  return WORKSPACE_FREE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export const Route = createFileRoute("/_app")({
  // The bookmark modal opens over any page of the app from these parameters (`bookmarks/modal-search.ts`).
  validateSearch: validateBookmarkModalSearch,
  // Every page of the app needs a session (see `requireAccount`). An account that acts in no workspace has
  // nothing to show on the pages of a workspace: it is sent to the page that says what to do about that.
  beforeLoad: async ({ context, location }) => {
    const me = await requireAccount({ context, location });
    if (me?.activeWorkspaceId === null && !isWorkspaceFreePage(location.pathname)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/no-workspace", replace: true });
    }
  },
  component: AppLayout,
});
