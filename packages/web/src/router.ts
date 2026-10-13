import { createRoute, createRouter, type AnyRoute, type RouterHistory } from "@tanstack/react-router";
import { assertValidExtensions, type WebExtension } from "./extensions/index.ts";
import type { RouterContext } from "./router-context.ts";
import { Route as appLayoutRoute } from "./routes/_app.tsx";
import { routeTree } from "./routeTree.gen.ts";
import { RoutePending } from "./shell/route-pending.tsx";

// The generated tree is a module singleton and an extension's pages are added to its
// layout route, so the app's own pages are captured once and every router starts from them.
const appPages: readonly AnyRoute[] = Object.values(appLayoutRoute.children ?? {});

export function createAppRouter(context: RouterContext, extensions: readonly WebExtension[], history?: RouterHistory) {
  assertValidExtensions(
    extensions,
    appPages.map((page) => String(page.fullPath)),
  );
  const extensionPages = extensions.flatMap(({ routes = [] }) =>
    routes.map(({ path, component }) => createRoute({ getParentRoute: () => appLayoutRoute, path, component })),
  );
  appLayoutRoute.addChildren([...appPages, ...extensionPages]);
  return createRouter({
    routeTree,
    context,
    defaultPreload: "intent",
    defaultPendingComponent: RoutePending,
    ...(history === undefined ? {} : { history }),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
