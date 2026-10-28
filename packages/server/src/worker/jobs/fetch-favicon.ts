import { FAVICON_HOST_MAX_LENGTH, FAVICON_HOST_PATTERN } from "@slugbase/contracts";
import { fetchFavicon } from "@slugbase/core";
import { faviconRepository, type FaviconResult, type QueuedJob } from "@slugbase/db";
import { z } from "zod";
import { defineJob } from "../job.ts";

// `favicon.fetch` (doc 02 section 5.4, doc 01 section 8.1, doc 10 T6 and T14): fetches the icon of a host, re-encodes it to PNG at 64 and 32 pixels and stores it
// for the whole deployment, for seven days. It is queued by `GET /api/v1/favicons/{host}` for a host of a bookmark the requesting member can read, and the job
// carries that member's account and workspace with the host and nothing else: when it runs it asks again whether the account can still read a bookmark on the host in
// that workspace, so a bookmark deleted, archived or made unreadable since the job was queued fetches nothing. A host whose icon has not expired is left alone, so a
// second job for the same host does nothing.
//
// The fetch (`fetchFavicon` of `@slugbase/core`) goes through the egress port and nowhere else: `/favicon.ico` and the `<link rel=icon>` targets of the home page,
// each read to at most 64 KiB (a longer body is refused, never cut), only image content types, every body handed to the image codec, which refuses an SVG and anything
// but a PNG, JPEG, GIF, WebP or ICO and an image above its pixel cap, and encodes the PNGs afresh. A host none of whose candidates gives a usable icon is stored as
// `none`; that is an answer, not an error of the job. An egress port or a codec that is not configured, and a database error, are errors of the job and are retried;
// nothing is stored for them. No transaction is open while the requests run, so a slow site holds no database connection.
//
// The queue keeps one waiting job for each host (`dedupe`), so a host asked for by many members at once is fetched once.

export const FETCH_FAVICON_JOB = "favicon.fetch";

/** The request id of the tenant transactions of a run; there is no request. */
const JOB_REQUEST_ID = FETCH_FAVICON_JOB;

export const fetchFaviconJob = defineJob({
  name: FETCH_FAVICON_JOB,
  payload: z.object({
    host: z.string().max(FAVICON_HOST_MAX_LENGTH).regex(FAVICON_HOST_PATTERN),
    workspaceId: z.uuid(),
    accountId: z.uuid(),
  }),
  dedupe: true,
  handle: async ({ host, workspaceId, accountId }, context) => {
    const tenant = { accountId, workspaceId, requestId: JOB_REQUEST_ID };
    const target = await context.withTenant(tenant, async (tx) => {
      const repository = faviconRepository(tx);
      if (!(await repository.hostReadable(host))) {
        return "unreadable" as const;
      }
      return (await repository.current(host, 64)) === undefined ? ("fetch" as const) : ("cached" as const);
    });
    if (target === "unreadable") {
      // The member can no longer read a bookmark on the host in that workspace (deleted, archived, or the workspace is going), and a retry would find the same.
      context.logger.info("Favicon not fetched; no bookmark the member can read is on the host");
      return;
    }
    if (target === "cached") {
      context.logger.info("Favicon not fetched; the cached icon has not expired");
      return;
    }
    const outcome = await fetchFavicon({ egress: context.adapters.egress, imageCodec: context.adapters.imageCodec }, host);
    const result: FaviconResult = outcome.kind === "ok" ? { status: "ok", png64: outcome.png64, png32: outcome.png32 } : { status: "none" };
    await context.withTenant(tenant, (tx) => faviconRepository(tx).store(host, result));
    context.logger.info("Favicon cached", { status: result.status });
  },
});

/**
 * The job that fetches the icon of `host` for a member who can read a bookmark on it, for the transaction that finds the icon missing. Its singleton key is the
 * host, so the queue holds one waiting job for it.
 */
export function queueFetchFavicon(id: string, request: { readonly host: string; readonly workspaceId: string; readonly accountId: string }): QueuedJob {
  const payload = fetchFaviconJob.parse(request);
  return { id, queue: FETCH_FAVICON_JOB, data: { host: payload.host, workspaceId: payload.workspaceId, accountId: payload.accountId }, singletonKey: payload.host };
}
