import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { requireAccount } from "../account/require-account.ts";
import { GoPage } from "../go/go-page.tsx";

function GoRoute(): ReactElement {
  const { slug } = Route.useParams();
  // A new slug is a new page: nothing read for the previous one stays.
  return <GoPage beyondSlug={false} key={slug} slug={slug} />;
}

export const Route = createFileRoute("/go/$slug")({
  // The page is for a signed-in member who acts in a workspace: a visitor without a session comes back to the slug after
  // signing in, and an account that acts in no workspace has nothing to resolve a slug in.
  beforeLoad: async ({ context, location }) => {
    const me = await requireAccount({ context, location });
    if (me?.activeWorkspaceId === null) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/no-workspace", replace: true });
    }
  },
  component: GoRoute,
});
