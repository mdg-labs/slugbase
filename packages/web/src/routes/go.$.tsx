import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { requireAccount } from "../account/require-account.ts";
import { GoPage } from "../go/go-page.tsx";

function GoBeyondSlugRoute(): ReactElement {
  return <GoPage beyondSlug slug="" />;
}

// A path after the slug, or no slug at all, is not an address of a bookmark (doc 02 section 6.2 step 5): it shows the page that does not exist,
// without the sidebar of the app, as the server answers it.
export const Route = createFileRoute("/go/$")({
  beforeLoad: async ({ context, location }) => {
    const me = await requireAccount({ context, location });
    if (me?.activeWorkspaceId === null) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/no-workspace", replace: true });
    }
  },
  component: GoBeyondSlugRoute,
});
