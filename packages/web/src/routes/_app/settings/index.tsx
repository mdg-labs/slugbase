import { createFileRoute, redirect } from "@tanstack/react-router";

// The settings have no page of their own; the first one is the account's profile.
export const Route = createFileRoute("/_app/settings/")({
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
    throw redirect({ to: "/settings/account", replace: true });
  },
});
