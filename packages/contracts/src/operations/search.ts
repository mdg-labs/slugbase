import { z } from "zod";
import { defineOperation, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

// The search tag of doc 04 section 10.8 (doc 02 section 9.1): one query across the caller's readable bookmarks, own folders and own tags, grouped by type. It acts in the workspace the
// request is bound to and names none (D11). Bookmarks rank an exact slug, a slug prefix, full text over the title, host, slug and description, and then trigram similarity on title and
// host; folders and tags match by name. Plan-archived bookmarks never match, and another member's bookmarks, folders and tags and anything of another workspace are never in an answer
// (doc 10 T1 and T2). The query is plain text: query syntax characters in it are never operators.

/** The types of result a search can return. */
export const SEARCH_TYPES = ["bookmark", "folder", "tag"] as const;

/** The longest query, in characters; a longer one is refused. */
export const SEARCH_QUERY_MAX_LENGTH = 100;

/** The most results of one type a search returns, whatever `limit` asks for. */
export const SEARCH_MAX_LIMIT = 20;

/** The number of results of each type when `limit` is left out. */
export const SEARCH_DEFAULT_LIMITS = { bookmark: 8, folder: 4, tag: 4 } as const;

const SEARCH_TYPES_PATTERN = /^(?:bookmark|folder|tag)(?:,(?:bookmark|folder|tag))*$/;

export const SearchQuerySchema = z.strictObject({
  q: z
    .string()
    .trim()
    .min(1)
    .max(SEARCH_QUERY_MAX_LENGTH)
    .describe(
      "The text to search for, 1 to 100 characters after the whitespace around it is removed. It is plain text: `&`, `|`, `!`, `:`, `*`, `%`, `_`, quotes and backslashes are never operators or wildcards. A text of fewer than three characters matches a bookmark by the start of its slug or its title only; a folder or a tag still matches it anywhere in its name",
    ),
  types: z
    .string()
    .regex(SEARCH_TYPES_PATTERN)
    .optional()
    .describe("The types to search, a comma-separated list of bookmark, folder and tag. A type that is left out comes back as an empty list. All three when the parameter is left out"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SEARCH_MAX_LIMIT)
    .optional()
    .describe("The most results of each type to return, at most 20. Left out, a search returns 8 bookmarks, 4 folders and 4 tags"),
});

export const SearchBookmarkSchema = z
  .strictObject({
    id: z.uuid().describe("The bookmark's identifier"),
    title: z.string().describe("The bookmark's title"),
    url: z.string().describe("The URL as stored: normalised, and always http or https"),
    host: z.string().describe("The host name of the URL, lower case and in punycode"),
    slug: z.string().nullable().describe("The bookmark's slug, null when it has none"),
    forwarding: z.boolean().describe("Whether /go forwards to the bookmark by its slug"),
    pinned: z.boolean().describe("Whether the bookmark is pinned"),
  })
  .meta({ id: "SearchBookmark" });

export const SearchFolderSchema = z
  .strictObject({
    id: z.uuid().describe("The folder's identifier"),
    name: z.string().describe("The folder's name, in the case it was entered in"),
    icon: z.string().describe("The folder's icon: a lucide icon name from the list the folder operations publish"),
    color: z.number().int().min(1).max(8).describe("The folder's colour, 1 to 8: the number of the --folder-N theme token"),
  })
  .meta({ id: "SearchFolder" });

export const SearchTagSchema = z
  .strictObject({
    id: z.uuid().describe("The tag's identifier"),
    name: z.string().describe("The tag's name, in the case it was entered in"),
  })
  .meta({ id: "SearchTag" });

export const SearchResultsSchema = z
  .strictObject({
    bookmarks: z.array(SearchBookmarkSchema).describe("The caller's bookmarks that match, best first: an exact slug, then a slug prefix, then full text, then trigram similarity; plan-archived bookmarks never match"),
    folders: z.array(SearchFolderSchema).describe("The caller's own folders whose name contains the text, an exact name first, then a name that starts with it, then the rest; another member's folders are never in it"),
    tags: z.array(SearchTagSchema).describe("The caller's own tags whose name contains the text, in the order of the folders; another member's tags are never in it"),
  })
  .meta({ id: "SearchResults" });

export const search = defineOperation({
  method: "get",
  path: "/api/v1/search",
  operationId: "search",
  tag: "search",
  summary: "Search my bookmarks, folders and tags",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { query: SearchQuerySchema },
  responses: {
    200: jsonResponse("The matches grouped by type, each group at most `limit` long (8 bookmarks, 4 folders and 4 tags by default); a type that was not asked for, and a text that matches nothing, give empty lists", SearchResultsSchema),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The query did not pass validation (a missing, blank or over-long q, a types list with a value other than bookmark, folder and tag, a limit outside 1 to 20, or an unknown parameter)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
