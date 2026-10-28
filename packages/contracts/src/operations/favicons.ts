import { z } from "zod";
import { binaryResponse, defineOperation, problemResponse, rateLimitedResponse } from "./define.ts";

// The favicons tag of doc 04 section 10.6 (doc 02 section 5.4, doc 10 T6 and T14): the icon of a host, served from the app's own origin so that the browser never
// contacts the bookmarked site to draw a list. The host is the host of a bookmark (lower case, in punycode). The icon is the PNG the server re-encoded from
// what it fetched, never the fetched bytes, and it is always `image/png` with `X-Content-Type-Options: nosniff`; an SVG source is refused and never served. An icon
// that is not in the cache yet is answered with a transparent placeholder, and a fetch is queued when the caller can read a bookmark on the host.

/** The longest host name, in characters. */
export const FAVICON_HOST_MAX_LENGTH = 253;

/** A host name in lower case: dot-separated labels of 1 to 63 letters, digits and hyphens that neither start nor end with a hyphen. A name in Unicode is sent in punycode. */
export const FAVICON_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** The edge lengths of the icons the server stores, in pixels. */
export const FAVICON_SIZES = ["32", "64"] as const;

/** How long the browser may keep a stored icon, in seconds: the seven days a cached icon lives. */
export const FAVICON_CACHE_MAX_AGE_SECONDS = 604_800;

/** How long the browser may keep the placeholder, in seconds. */
export const FAVICON_PLACEHOLDER_MAX_AGE_SECONDS = 60;

export const FaviconParamsSchema = z.strictObject({
  host: z
    .string()
    .max(FAVICON_HOST_MAX_LENGTH)
    .regex(FAVICON_HOST_PATTERN)
    .describe("The host name, in lower case and in punycode, as a bookmark's host is: labels of letters, digits and hyphens separated by dots, at most 253 characters, with no port, path or address in brackets"),
});

export const FaviconQuerySchema = z.strictObject({
  size: z.enum(FAVICON_SIZES).optional().describe("The edge of the icon in pixels, 32 or 64. 64 when the parameter is left out"),
});

const imageHeaders = (maxAgeSeconds: number, kind: string): Record<string, { description: string; schema: z.ZodType }> => ({
  "Cache-Control": { description: `${kind}: cacheable by the browser only (private) for ${String(maxAgeSeconds)} seconds`, schema: z.literal(`private, max-age=${String(maxAgeSeconds)}`) },
  "X-Content-Type-Options": { description: "Always nosniff, so the browser reads the body as the PNG it is", schema: z.literal("nosniff") },
});

export const getFavicon = defineOperation({
  method: "get",
  path: "/api/v1/favicons/{host}",
  operationId: "getFavicon",
  tag: "favicons",
  summary: "The icon of a host",
  auth: "member",
  rate: "fetch",
  rateTakenByHandler: true,
  request: { params: FaviconParamsSchema, query: FaviconQuerySchema },
  responses: {
    200: binaryResponse(
      "The cached icon of the host, a PNG that the server encoded itself from an image of at most 64 KiB that it fetched through the egress adapter; never SVG and never the fetched bytes. The browser may keep it for seven days",
      "image/png",
      { headers: imageHeaders(FAVICON_CACHE_MAX_AGE_SECONDS, "A stored icon") },
    ),
    202: binaryResponse(
      "The host has no icon in the cache: a transparent placeholder PNG, which the browser keeps for a minute only. When the caller can read a bookmark on the host and the host is not known to have none, a fetch is queued; a host with no icon the server can use stays a placeholder until the record expires, and the web app draws a monogram for it",
      "image/png",
      { headers: imageHeaders(FAVICON_PLACEHOLDER_MAX_AGE_SECONDS, "The placeholder") },
    ),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The credential is an API token, which cannot read icons (forbidden)"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The host is not a lower-case host name in punycode of at most 253 characters, or the size is not 32 or 64, or a parameter the operation does not declare was sent"),
    429: rateLimitedResponse("Too many requests, or too many fetches were started; Retry-After says when to try again. Every request takes from the read limit; only a request that would start a fetch takes from the fetch limit, and one answered from the cache never does"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
