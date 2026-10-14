import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import type { RouterContext } from "../router-context.ts";
import { ServerErrorPage } from "../shell/error-pages.tsx";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  errorComponent: ServerErrorPage,
});
