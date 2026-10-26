import { defineOperation, emptyResponse, problemResponse, rateLimitedResponse } from "@slugbase/contracts";
import { navigateToSlug, parseSlug, type BookmarkUsage } from "@slugbase/core";
import { goRepository } from "@slugbase/db";
import type { ChainContext, MatchedRoute, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { webShell, type Shell } from "./shell.ts";

// GET /go/<slug> (doc 02 section 6.2, doc 04 section 9.3, doc 10 T1, T2, T4, T12 and residual 3): the product's entry point, typed into the address bar, so it is a
// browser navigation and not an operation of the API. It has no contract in the document of the API, which holds `/api/v1` and the probes; its operations are
// declared here for the chain's policy alone (the `go` bucket, a signed-in browser session) and are registered apart from the contract check of the other routes.
//
// Every answer is one of: a `302` to sign in, a `302` to the destination, the SPA shell, or a problem. The sign-in redirect goes before anything is looked up, so a
// signed-out browser learns nothing about a slug. A bearer credential is refused with `401` whatever it is, because an API token cannot navigate, and a
// partial session (the second factor still owed) goes to the second step. A signed-in member takes one token of the account's `go` limit, then the slug is
// resolved in the active workspace only. A cross-site top-level `GET` is allowed (doc 10 section 5, residual 3): there is no state to change but a usage counter and the deletion of the member's own remembered choice for the slug when it is no candidate any more (doc 02 section 6.4).
//
// The shell is answered with `200` where the member has to choose among several bookmarks and with `404` where nothing is found, and a slug outside the grammar,
// anything after the slug (a path or a query string, Q43), a member with no workspace and a destination that is not an `http` or `https` URL are the second. The
// SPA reads the same URL to render the page. Both are `no-store` with `Referrer-Policy: no-referrer`, as the redirect is: the headers stage sets them for every path
// under `/go`. A composition without a web build has no shell to answer with and answers `404 not_found` instead.

const SIGN_IN = "/login";
const SIGN_IN_SECOND_STEP = "/login/mfa";
const AUTHENTICATION_REQUIRED = "Authentication is required.";
const NO_SUCH_RESOURCE = "No such resource.";

const forward = defineOperation({
  method: "get",
  path: "/go/{slug}",
  operationId: "goToSlug",
  tag: "go",
  summary: "Forward a browser navigation to the destination of a slug",
  auth: "anonymous",
  rate: "go",
  responses: {
    302: emptyResponse("To sign in, to the second step of signing in, or to the destination of the slug"),
    401: problemResponse("The request carries an Authorization header; an API token cannot navigate"),
    404: problemResponse("The composition serves no web build to answer with"),
    429: rateLimitedResponse("Too many navigations from this address or by this account"),
  },
});

const beyond = defineOperation({
  method: "get",
  path: "/go/*",
  operationId: "goBeyondSlug",
  tag: "go",
  summary: "Refuse a path after the slug, or no slug at all",
  auth: "anonymous",
  rate: "go",
  responses: {
    302: emptyResponse("To sign in, or to the second step of signing in"),
    401: problemResponse("The request carries an Authorization header; an API token cannot navigate"),
    404: problemResponse("The composition serves no web build to answer with"),
    429: rateLimitedResponse("Too many navigations from this address or by this account"),
  },
});

const SHELL_STATUSES: ReadonlySet<number> = new Set([200, 404]);
const HTML = "text/html";

/** Whether the response is the SPA shell a `/go` navigation answered, which has no schema in a contract to be checked against. */
export function isGoShell(context: ChainContext): boolean {
  const operationId = context.get("route")?.operation.operationId;
  return (
    (operationId === forward.operationId || operationId === beyond.operationId) &&
    SHELL_STATUSES.has(context.res.status) &&
    (context.res.headers.get("content-type") ?? "").toLowerCase().startsWith(HTML)
  );
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

async function shellAnswer(shell: Shell | undefined, status: 200 | 404): Promise<Response> {
  const page = await shell?.();
  if (page === undefined) {
    throw new ProblemError("not_found", NO_SUCH_RESOURCE);
  }
  return new Response(page, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export interface GoNavigationOptions {
  /** Where a use is counted; the usage buffer of the server process. */
  readonly usage: BookmarkUsage;
  /** The web root of the composition; without one there is no shell to answer with. */
  readonly webRoot: string | undefined;
}

export function goNavigationRoutes({ usage, webRoot }: GoNavigationOptions): RouteBinding[] {
  const shell = webShell(webRoot);

  async function navigate(context: ChainContext, route: MatchedRoute): Promise<Response> {
    // An API token never navigates, even where nothing resolves it to a principal; the chain has already refused a credential nothing accepts.
    if (context.req.raw.headers.has("authorization")) {
      throw new ProblemError("unauthenticated", AUTHENTICATION_REQUIRED);
    }
    const plain = route.operation.operationId === forward.operationId && new URL(context.req.url).search === "";
    const slug = plain ? parseSlug(route.params["slug"] ?? "") : undefined;

    const principal = context.get("principal");
    if (principal === undefined) {
      return redirectTo(slug === undefined ? SIGN_IN : `${SIGN_IN}?returnTo=/go/${slug}`);
    }
    if (principal.kind !== "session") {
      throw new ProblemError("unauthenticated", AUTHENTICATION_REQUIRED);
    }
    if (principal.mfaPending === true) {
      return redirectTo(slug === undefined ? SIGN_IN_SECOND_STEP : `${SIGN_IN_SECOND_STEP}?returnTo=/go/${slug}`);
    }

    const takeAccountLimit = context.get("takeAccountLimit");
    if (takeAccountLimit === undefined) {
      throw new Error("the go route was reached without the rate-limit stage that counts navigations per account");
    }
    await takeAccountLimit(context, principal.accountId);

    const tenant = context.get("tenant");
    if (slug === undefined || tenant === undefined) {
      return shellAnswer(shell, 404);
    }
    const navigation = await tenant.withTenant((tx) => navigateToSlug({ store: goRepository(tx), usage }, { accountId: tenant.accountId, slug }));
    switch (navigation.kind) {
      case "forward":
        return redirectTo(navigation.url);
      case "choose":
        return shellAnswer(shell, 200);
      case "not_found":
        return shellAnswer(shell, 404);
    }
  }

  return [
    { operation: forward, handler: navigate },
    { operation: beyond, handler: navigate },
  ];
}
