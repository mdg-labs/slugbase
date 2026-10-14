import { createFileRoute, redirect } from "@tanstack/react-router";
import { isSessionEnded } from "../api/client.ts";
import { meQuery } from "../account/me.ts";
import { sessionQuery } from "../auth/session.ts";
import { AppLayout } from "../shell/app-layout.tsx";

export const Route = createFileRoute("/_app")({
  // Every page of the app needs a session: a visitor without one is sent to sign in, and comes back to
  // the page they asked for. A check that fails for any other reason is not a signed-in visitor either,
  // so the error page shows instead of the app.
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.query({ ...sessionQuery(context.api), staleTime: "static" });
    } catch (error) {
      if (isSessionEnded(error)) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
        throw redirect({ to: "/login", search: { next: location.href }, replace: true });
      }
      throw error;
    }
    // The account carries the preferences that shape the first render: language, theme, accent, shortcuts.
    // It is not a gate: when it cannot be loaded the interface keeps what the browser remembers, and the
    // pages that need the account ask again and show their own failure.
    try {
      await context.queryClient.query({ ...meQuery(context.api), retry: false, staleTime: "static" });
    } catch (error) {
      if (isSessionEnded(error)) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown redirect (#82)
        throw redirect({ to: "/login", search: { next: location.href }, replace: true });
      }
    }
  },
  component: AppLayout,
});
