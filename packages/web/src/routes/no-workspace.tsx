import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireAccount } from "../account/require-account.ts";
import { NoWorkspacePage } from "../shell/no-workspace-page.tsx";

export const Route = createFileRoute("/no-workspace")({
  // The page is for an account with a session and no workspace to act in: one that acts in a workspace has
  // nothing to do here. When the account cannot be loaded the page asks again and shows its own failure.
  beforeLoad: async ({ context, location }) => {
    const me = await requireAccount({ context, location });
    if (me !== undefined && me.activeWorkspaceId !== null) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/", replace: true });
    }
  },
  component: NoWorkspacePage,
});
