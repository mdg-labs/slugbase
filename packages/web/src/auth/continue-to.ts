import type { RouterHistory } from "@tanstack/react-router";
import { navigateTo } from "./navigate.ts";
import { isServerPath, safeNextPath } from "./next-path.ts";

/**
 * Goes where the sign-in was headed: `next` when it is a path of this origin, otherwise home. A path the server answers (`/go/<slug>`, which it forwards
 * with a `302`) is reached by a request to the server; the router would answer it with a page of its own.
 */
export function continueTo(history: RouterHistory, next: string | undefined): void {
  const target = safeNextPath(next);
  if (isServerPath(target)) {
    navigateTo(target);
  } else {
    history.replace(target);
  }
}
