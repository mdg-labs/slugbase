import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { isSetupRequired } from "../config/setup-state.ts";
import { InvitePage } from "./-invite-page.tsx";

function InviteRoute(): ReactElement {
  const { token } = Route.useParams();
  // A new link is a new page: nothing read for the previous token stays. A failure of the page reaches the root
  // boundary, which names its own route match and shows static copy, so the token is in neither.
  return <InvitePage key={token} token={token} />;
}

export const Route = createFileRoute("/invite/$token")({
  // The link is for whoever opens it, signed in or not; the page asks who that is itself, because a visitor
  // without a session is the expected one and must not be sent to sign in.
  // While the instance has no account there is nothing to join: the visitor is sent to set it up.
  beforeLoad: ({ context }) => {
    if (isSetupRequired(context.queryClient)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
      throw redirect({ to: "/setup", replace: true });
    }
  },
  component: InviteRoute,
});
