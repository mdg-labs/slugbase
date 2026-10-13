import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
import type { RouterContext } from "./router-context.ts";

export function createAppRouter(context: RouterContext) {
  return createRouter({ routeTree, context, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
