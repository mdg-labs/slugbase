import type { ChallengePort } from "@slugbase/core";
import type { Logger } from "../create-server.ts";
import type { ChainContext, RequestStage } from "./chain.ts";
import { problemDocument, requestIdOf } from "./problem.ts";

// Stage 5 of the chain (doc 01 section 4, doc 04 section 5): every browser-facing
// POST, PUT, PATCH and DELETE, whether it carries a session cookie or none, must
// come from the app's own origin and be JSON. There is no path allowlist (Q5):
// sign-in, registration, setup and reset are checked like any other mutation.
//
// The only requests that skip the rule are the ones that carry no ambient
// credential or are declared so in their route: a request with a bearer token
// (stage 3 holds its content type), a `machine` route and a `marketing-form`
// route. A request that sends an Authorization header, and a route with an
// audience, has its cookies dropped here so no later stage or handler can act on
// the browser's session.

const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BEARER = /^bearer\s/i;
const JSON_MEDIA_TYPE = "application/json";
const MULTIPART_MEDIA_TYPE = "multipart/form-data";

/** The header a marketing-site proxy forwards the visitor's bot-protection solution in. */
export const CHALLENGE_SOLUTION_HEADER = "x-challenge-solution";

const MAX_LOGGED_ORIGIN_LENGTH = 100;

type Refusal = "missing_origin" | "origin_mismatch" | "cross_site_fetch" | "content_type" | "preflight";

const DETAILS: Record<Refusal, string> = {
  missing_origin: "This request must come from the application itself.",
  origin_mismatch: "This request must come from the application itself.",
  cross_site_fetch: "This request must come from the application itself.",
  content_type: "This request must be sent as application/json.",
  preflight: "Cross-origin requests are not accepted.",
};

export interface CrossSiteOptions {
  /** `APP_ORIGIN`: the one origin a browser-facing mutation may come from. */
  readonly appOrigin: string;
  /** Verifies the bot-protection solution of a `marketing-form` request. */
  readonly challenge: ChallengePort;
  readonly logger: Logger;
}

/** What is safe to put in a log line: printable ASCII only, and no more than a short prefix. */
export function sanitiseOrigin(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const printable = value.replace(/[^\x20-\x7e]/g, "?");
  return printable.length > MAX_LOGGED_ORIGIN_LENGTH ? `${printable.slice(0, MAX_LOGGED_ORIGIN_LENGTH)}...` : printable;
}

function mediaTypeOf(headers: Headers): string | undefined {
  return headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/** The request without its cookies; the body, already bounded by stage 3, is carried over. */
async function withoutCookies(context: ChainContext): Promise<void> {
  const raw = context.req.raw;
  if (!raw.headers.has("cookie")) {
    return;
  }
  const headers = new Headers(raw.headers);
  headers.delete("cookie");
  const bytes = raw.body === null ? undefined : new Uint8Array(await raw.arrayBuffer());
  context.req.raw = new Request(raw.url, {
    method: raw.method,
    headers,
    signal: raw.signal,
    ...(bytes === undefined || bytes.byteLength === 0 ? {} : { body: bytes }),
  });
}

export function createCrossSiteProtection({ appOrigin, challenge, logger }: CrossSiteOptions): RequestStage {
  const expectedOrigin = new URL(appOrigin).origin;

  const refuse = (context: ChainContext, reason: Refusal, origin: string | null): Response => {
    (context.get("logger") ?? logger).warn("Cross-site request refused", {
      reason,
      method: context.req.method,
      origin: sanitiseOrigin(origin),
    });
    return problemDocument(requestIdOf(context), { code: "cross_site_request", detail: DETAILS[reason] });
  };

  return async (context, next) => {
    const raw = context.req.raw;
    const method = raw.method.toUpperCase();
    const route = context.get("route");
    const audience = route?.operation.audience;
    const origin = raw.headers.get("origin");

    // No CORS is ever granted on the API, so a preflight has nothing to be answered with.
    if (method === "OPTIONS" && isApiPath(new URL(raw.url).pathname)) {
      return refuse(context, "preflight", origin);
    }

    if (audience === "machine") {
      await withoutCookies(context);
      return next();
    }

    if (audience === "marketing-form") {
      await withoutCookies(context);
      if (route?.marketingOrigin === undefined || origin !== route.marketingOrigin) {
        return refuse(context, origin === null ? "missing_origin" : "origin_mismatch", origin);
      }
      if (mediaTypeOf(raw.headers) !== JSON_MEDIA_TYPE) {
        return refuse(context, "content_type", origin);
      }
      const verdict = await challenge.verify(raw.headers.get(CHALLENGE_SOLUTION_HEADER) ?? undefined);
      if (!verdict.ok) {
        return problemDocument(requestIdOf(context), { code: "forbidden", detail: "The challenge was not solved." });
      }
      return next();
    }

    const authorization = raw.headers.get("authorization");
    if (authorization !== null) {
      await withoutCookies(context);
      if (BEARER.test(authorization)) {
        return next();
      }
    }

    if (!MUTATIONS.has(method)) {
      return next();
    }

    if (origin === null) {
      return refuse(context, "missing_origin", origin);
    }
    if (origin !== expectedOrigin) {
      return refuse(context, "origin_mismatch", origin);
    }
    const site = raw.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin") {
      return refuse(context, "cross_site_fetch", origin);
    }
    const mediaType = mediaTypeOf(raw.headers);
    if (mediaType !== JSON_MEDIA_TYPE && !(route?.acceptsMultipart === true && mediaType === MULTIPART_MEDIA_TYPE)) {
      return refuse(context, "content_type", origin);
    }
    return next();
  };
}
