import type { RouterHistory } from "@tanstack/react-router";
import type { Middleware } from "openapi-fetch";
import { ApiProblemError, type ApiProblemCode } from "../api/client.ts";

export const LOGIN_PATH = "/login";
export const MFA_PATH = "/login/mfa";

const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** The sign-in page, keeping the page the visitor was headed for. */
export function loginPath(next: string | undefined): string {
  return next === undefined ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}

/** The second step of the sign-in, keeping the page the visitor was headed for. */
export function mfaPath(next: string | undefined): string {
  return next === undefined ? MFA_PATH : `${MFA_PATH}?next=${encodeURIComponent(next)}`;
}

/** Whether the error is a `401` that says the session is only half signed in: the second factor is still to be given. */
export function isMfaRequired(error: unknown): boolean {
  return error instanceof ApiProblemError && error.status === 401 && error.code === "mfa_required";
}

async function readProblem(response: Response): Promise<{ code: ApiProblemCode; requestId: string } | undefined> {
  if (!(response.headers.get("Content-Type") ?? "").toLowerCase().startsWith(PROBLEM_CONTENT_TYPE)) {
    return undefined;
  }
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const { code, requestId } = body as Record<string, unknown>;
  return typeof code === "string" && typeof requestId === "string" ? { code: code as ApiProblemCode, requestId } : undefined;
}

/**
 * Middleware of the API client for the second step of the sign-in. A session that only passed the
 * password answers every other call `401 mfa_required` (doc 04 section 4.3); that is not a session that
 * has ended, so it is raised as an error without the session-ended handling and the visitor is taken to
 * `/login/mfa`. On `/login/mfa` itself a `401` means the pending session is gone, and the page takes the
 * visitor back to sign in. The sign-in page leaves every answer to the problem middleware. Register it
 * after the problem middleware, which it has to answer before.
 */
export function mfaMiddleware(history: RouterHistory): Middleware {
  return {
    async onResponse({ response }) {
      if (response.status !== 401 || history.location.pathname === LOGIN_PATH) {
        return undefined;
      }
      const problem = await readProblem(response);
      if (problem === undefined || problem.code === "reauth_required") {
        return undefined;
      }
      const { pathname, href } = history.location;
      if (problem.code === "mfa_required") {
        if (pathname !== MFA_PATH) {
          history.replace(mfaPath(href));
        }
      } else if (pathname !== MFA_PATH) {
        return undefined;
      }
      throw new ApiProblemError({ ...problem, status: 401 });
    },
  };
}
