import { isRouteErrorResponse } from "react-router";
import { isAppErrorStatus, type AppErrorStatus } from "./error-status.js";
import { LoaderStatusError } from "./loader-status-error.js";

function readErrorStatus(error: unknown): number | null {
  if (isRouteErrorResponse(error)) {
    return error.status;
  }
  if (error instanceof LoaderStatusError) {
    return error.status;
  }
  if (
    error !== null &&
    typeof error === "object" &&
    "init" in error &&
    error.init !== null &&
    typeof error.init === "object" &&
    "status" in error.init
  ) {
    const initStatus = error.init.status;
    if (typeof initStatus === "number") {
      return initStatus;
    }
  }
  return null;
}

export function resolveRouteErrorStatus(error: unknown): AppErrorStatus {
  const status = readErrorStatus(error);
  if (status !== null && isAppErrorStatus(status)) {
    return status;
  }
  return 500;
}
