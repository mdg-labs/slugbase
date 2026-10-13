import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import type { RouterContext } from "../router-context.ts";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});
