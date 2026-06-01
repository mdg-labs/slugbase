import { useRouteError } from "react-router";
import { AppErrorPage } from "./AppErrorPage.js";
import { resolveRouteErrorStatus } from "./resolve-route-error-status.js";

export function AppErrorBoundary() {
  const error = useRouteError();
  const status = resolveRouteErrorStatus(error);

  return <AppErrorPage status={status} error={error} />;
}
