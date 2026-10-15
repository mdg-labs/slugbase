import { createFileRoute, notFound } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { isSetupRequired } from "../config/setup-state.ts";
import { NotFoundPage } from "../shell/error-pages.tsx";
import { SetupPage } from "../setup/setup-page.tsx";

function NotFoundOutsideShell(): ReactElement {
  return (
    <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center p-6">
      <NotFoundPage />
    </main>
  );
}

export const Route = createFileRoute("/setup")({
  // The wizard exists only while the instance has no account; afterwards the address is a page nobody owns.
  beforeLoad: ({ context }) => {
    if (!isSetupRequired(context.queryClient)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router takes a thrown notFound (#82)
      throw notFound();
    }
  },
  component: SetupPage,
  notFoundComponent: NotFoundOutsideShell,
});
