import { createHash } from "node:crypto";
import { METADATA_CONTENT_TYPES, METADATA_HTML_MAX_BYTES, parsePageMetadata, type EgressPort } from "@slugbase/core";
import { urlMetadataRepository, type QueuedJob, type UrlMetadataResult } from "@slugbase/db";
import { z } from "zod";
import { defineJob } from "../job.ts";

// `bookmark.fetchMetadata` (doc 02 section 5.4, doc 01 section 8.1, doc 10 T6 and T13): fetches the page a bookmark points at and caches what it
// says about itself for its workspace and canonical URL, for seven days. The job carries identifiers and nothing else: the bookmark, the workspace
// and the account that owns the bookmark. It re-reads the bookmark's canonical URL when it runs, so a bookmark that was re-pointed, archived or
// deleted since the job was queued is judged by what it is now, and it never changes a bookmark field: the cache row is all it writes. A result
// that has not expired is left alone, so a second job for the same page does nothing.
//
// The fetch goes through the egress port and nowhere else: the canonical URL (which carries no credentials, which the port refuses), at most the
// first 512 KiB, and only `text/html` and `application/xhtml+xml`. A target the port refuses is recorded as `blocked`, a status outside 2xx, a
// page of another type and any other error as `failed`; neither holds a field. Neither is an error of the job: the outcome is the cached answer,
// and a bookmark whose fetch failed keeps the fields as entered (doc 02 section 5.4). The page is parsed as text by `parsePageMetadata`, which
// executes and follows nothing. No transaction is open while the request runs, so a slow page holds no database connection. A database error
// is an error of the job and is retried.
//
// The queue keeps one waiting job for each workspace and canonical URL (`dedupe`), so a page saved or re-pointed several times in a moment is fetched once.

export const FETCH_METADATA_JOB = "bookmark.fetchMetadata";

/** The request id of the tenant transactions of a run; there is no request. */
const JOB_REQUEST_ID = FETCH_METADATA_JOB;

/** The time budget of one fetch, redirects included. */
export const FETCH_METADATA_TIMEOUT_MS = 10_000;

const REQUEST_HEADERS = { accept: "text/html,application/xhtml+xml", "user-agent": "SlugBase-Metadata" } as const;

/** The code the egress port gives a target it refuses; matched by value because the fake of the port does not share the class. */
const BLOCKED_CODE = "egress_blocked";

async function fetchPage(egress: EgressPort, urlCanonical: string): Promise<UrlMetadataResult> {
  try {
    const response = await egress.request({
      url: urlCanonical,
      headers: REQUEST_HEADERS,
      timeoutMs: FETCH_METADATA_TIMEOUT_MS,
      maxBytes: METADATA_HTML_MAX_BYTES,
      truncateAtMaxBytes: true,
      acceptContentTypes: METADATA_CONTENT_TYPES,
    });
    if (response.status < 200 || response.status >= 300) {
      return { status: "failed" };
    }
    const page = parsePageMetadata({ body: response.body, contentType: response.contentType, url: response.url });
    return page === undefined ? { status: "failed" } : { status: "ok", ...page };
  } catch (error) {
    return { status: (error as { code?: unknown } | null)?.code === BLOCKED_CODE ? "blocked" : "failed" };
  }
}

export const fetchMetadataJob = defineJob({
  name: FETCH_METADATA_JOB,
  payload: z.object({
    bookmarkId: z.uuid(),
    workspaceId: z.uuid(),
    accountId: z.uuid(),
  }),
  dedupe: true,
  handle: async ({ bookmarkId, workspaceId, accountId }, context) => {
    const tenant = { accountId, workspaceId, requestId: JOB_REQUEST_ID };
    const target = await context.withTenant(tenant, async (tx) => {
      const repository = urlMetadataRepository(tx);
      const urlCanonical = await repository.bookmarkUrl(bookmarkId);
      if (urlCanonical === undefined) {
        return { kind: "gone" } as const;
      }
      return (await repository.current(urlCanonical)) === undefined ? ({ kind: "fetch", urlCanonical } as const) : ({ kind: "cached" } as const);
    });
    if (target.kind === "gone") {
      // Deleted, archived, or its workspace is being deleted or gone since the job was queued: there is nothing to cache and a retry would find the same.
      context.logger.info("Metadata not fetched; the bookmark is gone or not readable");
      return;
    }
    if (target.kind === "cached") {
      context.logger.info("Metadata not fetched; the cached result has not expired");
      return;
    }
    const result = await fetchPage(context.adapters.egress, target.urlCanonical);
    await context.withTenant(tenant, (tx) => urlMetadataRepository(tx).store(target.urlCanonical, result));
    context.logger.info("Metadata cached", { status: result.status });
  },
});

/**
 * The job that fetches the page of a bookmark whose address was just set; for the transaction that writes the bookmark. Its singleton key names
 * the workspace and the canonical URL, so the queue holds one waiting job for them. The payload holds identifiers, never the URL.
 */
export function queueFetchMetadata(
  id: string,
  bookmark: { readonly bookmarkId: string; readonly workspaceId: string; readonly accountId: string },
  urlCanonical: string,
): QueuedJob {
  const payload = fetchMetadataJob.parse(bookmark);
  return {
    id,
    queue: FETCH_METADATA_JOB,
    data: { bookmarkId: payload.bookmarkId, workspaceId: payload.workspaceId, accountId: payload.accountId },
    singletonKey: `${payload.workspaceId}:${createHash("sha256").update(urlCanonical).digest("hex")}`,
  };
}
