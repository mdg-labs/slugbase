import { defineOperation, emptyResponse, rateLimitedResponse } from "@slugbase/contracts";
import type { ChainContext, RouteBinding } from "../http/chain.ts";

// GET /opensearch.xml (doc 04 section 9.4, doc 02 section 6.5): the description that lets a browser offer SlugBase as a search engine in one
// click. It is built from the two things the deployment configures, the origin the app is served from and the product name, and from nothing
// the request or a member supplies: the request's `Host` and `X-Forwarded-Host` are never read, so a forged one cannot make the document
// point a browser's address-bar search at another site. It is no operation of the API's document, which holds `/api/v1` and the probes, so
// its operation is declared here for the chain's policy alone (anonymous, the `public` bucket) and is registered apart from the contract
// check, as the `/go` navigation is. Its answer is XML, which has no schema in a contract to be checked against.

const OPEN_SEARCH_PATH = "/opensearch.xml";
const MEDIA_TYPE = "application/opensearchdescription+xml";
const CACHE_CONTROL = "public, max-age=3600";

// OpenSearch limits the short name to 16 characters.
const SHORT_NAME_MAX = 16;

const describeSearch = defineOperation({
  method: "get",
  path: OPEN_SEARCH_PATH,
  operationId: "getOpenSearchDescription",
  tag: "meta",
  summary: "The OpenSearch description of the go address",
  auth: "anonymous",
  rate: "public",
  responses: {
    200: emptyResponse("The OpenSearch description, an XML document that names the product and the go address on the configured origin"),
    429: rateLimitedResponse("Too many requests from this address"),
  },
});

const XML_ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character);
}

/** The first `max` characters of `text`, never cutting a character that takes two code units. */
function truncate(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

/** The description for a deployment at `origin` (`APP_ORIGIN`) whose product is called `productName`. */
export function openSearchDocument(origin: string, productName: string): string {
  const template = escapeXml(`${origin}/go/{searchTerms}`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">',
    `  <ShortName>${escapeXml(truncate(productName, SHORT_NAME_MAX))}</ShortName>`,
    `  <Description>${escapeXml(`Go to a ${productName} slug`)}</Description>`,
    "  <InputEncoding>UTF-8</InputEncoding>",
    `  <Url type="text/html" method="get" template="${template}"/>`,
    "</OpenSearchDescription>",
    "",
  ].join("\n");
}

/** Whether the response is the description this route answered, which has no schema in a contract to be checked against. */
export function isOpenSearchDocument(context: ChainContext): boolean {
  return context.get("route")?.operation.operationId === describeSearch.operationId && context.res.status === 200;
}

export interface OpenSearchOptions {
  /** `APP_ORIGIN`. */
  readonly appOrigin: string;
  /** The product's name from the build information. */
  readonly productName: string;
}

export function openSearchRoutes({ appOrigin, productName }: OpenSearchOptions): RouteBinding[] {
  // Nothing in it changes while the process runs.
  const document = openSearchDocument(appOrigin, productName);
  return [
    {
      operation: describeSearch,
      handler: () => new Response(document, { status: 200, headers: { "content-type": `${MEDIA_TYPE}; charset=utf-8`, "cache-control": CACHE_CONTROL } }),
    },
  ];
}
