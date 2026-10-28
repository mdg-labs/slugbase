import { getFavicon as getFaviconOperation, FAVICON_CACHE_MAX_AGE_SECONDS, FAVICON_PLACEHOLDER_MAX_AGE_SECONDS } from "@slugbase/contracts";
import { faviconRepository } from "@slugbase/db";
import type { ChainContext, RouteBinding } from "../http/chain.ts";
import { ProblemError } from "../http/problem.ts";
import type { RequestTenant } from "../http/tenant.ts";
import { uuidv7 } from "../auth/uuidv7.ts";
import { queueFetchFavicon } from "../worker/jobs/fetch-favicon.ts";
import { route } from "./register.ts";

// GET /api/v1/favicons/{host} (doc 04 section 10.6, doc 02 section 5.4, doc 10 T6 and T14). The icon of a host from the deployment-wide cache, served from our own origin so a
// list never makes the browser contact the bookmarked site. The operation needs a session and the host a hostname (the contract validates both); an API token is refused before the
// handler, since the operation declares no token scope.
//
// A stored icon is answered as `image/png` with `nosniff` and a private cache of seven days: the bytes are the PNG the server encoded itself (`sys_favicon_get` returns a column
// that `sys_favicon_put` only fills with a PNG), never the fetched ones. Anything else is the transparent placeholder, 202, cached for a minute. On a miss the handler queues
// `favicon.fetch`, and only for a host of a bookmark the caller can read in the active workspace (`hostReadable`), so the operation cannot be used to make the server fetch an
// arbitrary host; a host the cache knows to have no icon queues nothing until the record expires. Every request is limited by the `read` bucket (the operation declares `rateTakenByHandler`); the fetch bucket is taken besides, only for a request that would queue a fetch, and before it is queued: a request over the limit is the 429 and queues nothing.

const NO_WORKSPACE = "No such resource.";

/** A 1 by 1 PNG of one transparent pixel. */
const PLACEHOLDER = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQI12NgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==", "base64"),
);

/** The placeholder image, for tests. */
export const FAVICON_PLACEHOLDER: Uint8Array = PLACEHOLDER;

const NOSNIFF = "nosniff";
const STORED_CACHE = `private, max-age=${String(FAVICON_CACHE_MAX_AGE_SECONDS)}`;
const PLACEHOLDER_CACHE = `private, max-age=${String(FAVICON_PLACEHOLDER_MAX_AGE_SECONDS)}`;

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

const placeholder = () =>
  ({ status: 202, body: PLACEHOLDER, headers: { "Cache-Control": PLACEHOLDER_CACHE, "X-Content-Type-Options": NOSNIFF } }) as const;

export function faviconRoutes(): RouteBinding[] {
  return [
    route(getFaviconOperation).handle(async ({ params, query }, context) => {
      const tenant = tenantOf(context);
      const { host } = params;
      const edge = query.size === "32" ? 32 : 64;
      const found = await tenant.withTenant(async (tx) => {
        const repository = faviconRepository(tx);
        const current = await repository.current(host, edge);
        if (current !== undefined) {
          return { kind: "known", current } as const;
        }
        return { kind: "missing", readable: await repository.hostReadable(host) } as const;
      });
      if (found.kind === "known") {
        return found.current.status === "ok"
          ? { status: 200, body: found.current.png, headers: { "Cache-Control": STORED_CACHE, "X-Content-Type-Options": NOSNIFF } }
          : placeholder();
      }
      if (!found.readable) {
        return placeholder();
      }
      const takeBucketLimit = context.get("takeBucketLimit");
      if (takeBucketLimit === undefined) {
        throw new Error("the favicon operation was reached without its rate limit");
      }
      await takeBucketLimit(context);
      await tenant.withTenant((tx) =>
        faviconRepository(tx).enqueue(queueFetchFavicon(uuidv7(), { host, workspaceId: tenant.workspaceId, accountId: tenant.accountId })),
      );
      return placeholder();
    }),
  ];
}
