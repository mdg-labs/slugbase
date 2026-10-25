import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

// The folders tag of doc 04 section 10.7: the operations that create, list, read, change and delete a member's folders. They act in
// the workspace the request is bound to and name none (D11). A folder is its owner's (doc 02 section 7.1): another member's folder of
// the same workspace and any folder of another workspace are answered 404, like one that does not exist (doc 04 section 2.4, doc 10 T1
// and T2). Filing bookmarks, sharing a folder and the share summary are other operations.

/** The longest folder name, in characters (doc 05 section 2.4). */
export const FOLDER_NAME_MAX_LENGTH = 64;

/** The icon a folder has when none is chosen. */
export const FOLDER_DEFAULT_ICON = "folder";

/** The colour a folder has when none is chosen: the first of the eight `--folder-N` theme tokens (Q21). */
export const FOLDER_DEFAULT_COLOR = 1;

export const FOLDER_COLOR_MIN = 1;
export const FOLDER_COLOR_MAX = 8;

/**
 * The icons a folder may carry: lucide icon names (kebab-case), a curated list of sixty (doc 03 section 6, doc 05 section 2.4). The list
 * is configuration in code and not a table; the web app draws each name with its lucide component.
 */
export const FOLDER_ICONS = [
  "folder",
  "folder-open",
  "folder-heart",
  "folder-code",
  "folder-archive",
  "briefcase",
  "building-2",
  "book",
  "book-open",
  "bookmark",
  "star",
  "heart",
  "house",
  "newspaper",
  "graduation-cap",
  "flask-conical",
  "code",
  "terminal",
  "cpu",
  "database",
  "server",
  "cloud",
  "globe",
  "map",
  "map-pin",
  "plane",
  "car",
  "utensils",
  "coffee",
  "shopping-cart",
  "gift",
  "music",
  "film",
  "camera",
  "image",
  "video",
  "gamepad-2",
  "palette",
  "lightbulb",
  "rocket",
  "target",
  "trophy",
  "flag",
  "tag",
  "wallet",
  "credit-card",
  "dumbbell",
  "leaf",
  "sun",
  "moon",
  "zap",
  "shield",
  "lock",
  "users",
  "mail",
  "calendar",
  "inbox",
  "package",
  "wrench",
  "sparkles",
] as const;

export type FolderIcon = (typeof FOLDER_ICONS)[number];

const FolderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(FOLDER_NAME_MAX_LENGTH)
  .describe(
    "The folder's name, 1 to 64 characters after the whitespace around it is removed. It is stored as entered, in the case it is written in, and is unique among the caller's folders without regard to case",
  );

const FolderIconSchema = z.enum(FOLDER_ICONS).describe("The folder's icon: a lucide icon name from the list this schema publishes");

const FolderColorSchema = z
  .number()
  .int()
  .min(FOLDER_COLOR_MIN)
  .max(FOLDER_COLOR_MAX)
  .describe("The folder's colour, 1 to 8: the number of the --folder-N theme token the web app draws it with");

export const CreateFolderRequestSchema = z
  .strictObject({
    name: FolderNameSchema,
    icon: FolderIconSchema.optional().describe("The folder's icon: a lucide icon name from the list this schema publishes; folder when left out"),
    color: FolderColorSchema.optional().describe("The folder's colour, 1 to 8, the number of the --folder-N theme token; 1 when left out"),
  })
  .meta({ id: "CreateFolderRequest" });

export const UpdateFolderRequestSchema = z
  .strictObject({
    name: FolderNameSchema.optional().describe("The new name, 1 to 64 characters after the whitespace around it is removed; unique among the caller's folders without regard to case. Left out, the name is left as it is"),
    icon: FolderIconSchema.optional().describe("The new icon, a lucide icon name from the list this schema publishes. Left out, the icon is left as it is"),
    color: FolderColorSchema.optional().describe("The new colour, 1 to 8. Left out, the colour is left as it is"),
  })
  .meta({ id: "UpdateFolderRequest" });

export const FolderSchema = z
  .strictObject({
    id: z.uuid().describe("The folder's identifier"),
    ownerId: z.uuid().nullable().describe("The account of the member who owns the folder; null once that member has left the workspace"),
    name: z.string().describe("The folder's name, in the case it was entered in"),
    icon: z.string().describe("The folder's icon, a lucide icon name"),
    color: z.number().int().min(FOLDER_COLOR_MIN).max(FOLDER_COLOR_MAX).describe("The folder's colour, 1 to 8: the number of the --folder-N theme token"),
    bookmarkCount: z.number().int().min(0).describe("How many bookmarks are filed in the folder; plan-archived bookmarks are not counted"),
    version: z.number().int().min(1).describe("Moves by one with every change; the ETag header carries it and If-Match takes it back"),
    createdAt: z.iso.datetime().describe("When the folder was created, RFC 3339 UTC"),
    updatedAt: z.iso.datetime().describe("When the folder last changed, RFC 3339 UTC"),
  })
  .meta({ id: "Folder" });

export const FOLDER_SORTS = ["name", "count", "updated"] as const;

/** The most folders a page returns (doc 04 section 6.1). */
export const FOLDER_LIST_MAX_LIMIT = 100;

/** The page size when `limit` is left out (doc 04 section 6.1). */
export const FOLDER_LIST_DEFAULT_LIMIT = 50;

/** Where the total of a list stops being counted (Q42). */
export const FOLDER_LIST_TOTAL_CAP = 10_000;

/** The longest search text of `q`, in characters. */
export const FOLDER_SEARCH_MAX_LENGTH = 64;

/** The longest cursor a client may send back. The largest one the server issues carries a folder name (64 characters, up to 6 bytes each once JSON-escaped), a sort key, the identifier and the signature, as base64url: about 700 characters. */
export const FOLDER_CURSOR_MAX_LENGTH = 1024;

export const ListFoldersQuerySchema = z.strictObject({
  scope: z.enum(["all", "mine"]).default("all").describe("Whose folders are listed. Only the caller's own folders exist until sharing arrives, so both name the same folders today"),
  q: z.string().trim().min(1).max(FOLDER_SEARCH_MAX_LENGTH).optional().describe("Lists the folders whose name contains this text, without regard to case; left out, names are not filtered on"),
  sort: z
    .enum(FOLDER_SORTS)
    .default("name")
    .describe("The order, with the identifier as the tiebreak: name (alphabetical, ignoring case), count (most bookmarks first, then by name) or updated (last changed first)"),
  limit: z.coerce.number().int().min(1).max(FOLDER_LIST_MAX_LIMIT).default(FOLDER_LIST_DEFAULT_LIMIT).describe("The most folders to return, at most 100"),
  cursor: z
    .string()
    .min(1)
    .max(FOLDER_CURSOR_MAX_LENGTH)
    .optional()
    .describe("The `nextCursor` of the previous page. It is valid only with the scope, search and sort it was issued for, for the account and workspace that received it; any other cursor is refused with 400"),
});

export const FolderListSchema = z
  .strictObject({
    items: z.array(FolderSchema).describe("One page of the caller's folders in the workspace, in the order asked for; another member's folders are never listed"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
    total: z.number().int().min(0).nullable().describe("How many folders match the filters, across all pages: exact up to 10 000, and null above that, where totalAtLeast says so"),
    totalAtLeast: z.literal(FOLDER_LIST_TOTAL_CAP).optional().describe("Present, and 10 000, when total is null: the filters match more than 10 000 folders"),
  })
  .meta({ id: "FolderList" });

export const FolderParamsSchema = z.strictObject({
  id: z.uuid().describe("The folder's identifier"),
});

/** The precondition of doc 04 section 2.4: the `ETag` of the version the caller read, as a quoted entity tag, or `*`. */
export const FolderIfMatchHeaderSchema = z.object({
  "If-Match": z
    .string()
    .optional()
    .describe('The ETag of the version the change is made against, for example "3". A folder at another version answers 412 precondition_failed. Optional, so an API token may leave it out; `*` matches any version'),
});

const FolderEntityTag = {
  ETag: { description: 'The folder\'s version as an entity tag, for example "3"; the If-Match of the next change', schema: z.string() },
} as const;

export const createFolder = defineOperation({
  method: "post",
  path: "/api/v1/folders",
  operationId: "createFolder",
  tag: "folders",
  summary: "Create a folder",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { body: CreateFolderRequestSchema },
  responses: {
    201: jsonResponse("The folder, owned by the caller and private to them, with no bookmarks, version 1 and the defaults for the icon and the colour that were left out", FolderSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    409: problemResponse("The caller already has a folder with this name, in any case (name_taken); nothing is written"),
    422: problemResponse("The body did not pass validation (a name that is blank or longer than 64 characters, an icon outside the list, a colour outside 1 to 8, or a field the operation does not declare)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const listFolders = defineOperation({
  method: "get",
  path: "/api/v1/folders",
  operationId: "listFolders",
  tag: "folders",
  summary: "List my folders",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { query: ListFoldersQuerySchema },
  responses: {
    200: jsonResponse("One page of the caller's folders in the workspace in the order asked for, each with the number of bookmarks filed in it, the cursor of the next page and the total (exact up to 10 000, then null with totalAtLeast)", FolderListSchema),
    400: problemResponse("The request was malformed, or the cursor is not one this account was issued for this workspace, scope, search and sort (bad_request)"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The query did not pass validation (an unknown parameter, scope or sort, a limit outside 1 to 100, a search text longer than 64 characters)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const getFolder = defineOperation({
  method: "get",
  path: "/api/v1/folders/{id}",
  operationId: "getFolder",
  tag: "folders",
  summary: "Get a folder",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { params: FolderParamsSchema },
  responses: {
    200: jsonResponse("The caller's folder with the number of bookmarks filed in it", FolderSchema, { headers: FolderEntityTag }),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse(
      "The workspace the request acts in has no folder of the caller with this identifier: another member's folder, a folder of another workspace and one that never existed are answered alike",
    ),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const updateFolder = defineOperation({
  method: "patch",
  path: "/api/v1/folders/{id}",
  operationId: "updateFolder",
  tag: "folders",
  summary: "Change a folder",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: FolderParamsSchema, headers: FolderIfMatchHeaderSchema, body: UpdateFolderRequestSchema },
  responses: {
    200: jsonResponse(
      "The caller's folder after a JSON Merge Patch of its name, icon and colour. A change moves the version by one and the ETag is that of the new version; a patch that names the values the folder has, and an empty one, write nothing and answer with the unchanged version",
      FolderSchema,
      { headers: FolderEntityTag },
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse(
      "The workspace the request acts in has no folder of the caller with this identifier: another member's folder, a folder of another workspace and one that never existed are answered alike",
    ),
    409: problemResponse("The caller has another folder with this name, in any case (name_taken); nothing is written"),
    412: problemResponse("If-Match names a version other than the folder's current one (precondition_failed); the folder is unchanged"),
    422: problemResponse("The identifier or the body did not pass validation (a name that is blank or longer than 64 characters, an icon outside the list, a colour outside 1 to 8, or a field the operation does not declare). Nothing is written"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const deleteFolder = defineOperation({
  method: "delete",
  path: "/api/v1/folders/{id}",
  operationId: "deleteFolder",
  tag: "folders",
  summary: "Delete a folder",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: FolderParamsSchema },
  responses: {
    204: emptyResponse("The folder is deleted for good together with the associations of its bookmarks; the bookmarks stay"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse(
      "The workspace the request acts in has no folder of the caller with this identifier: another member's folder, a folder of another workspace, one that never existed and one that was deleted before are answered alike, since a hard delete keeps no tombstone and a repeat is not answered 204",
    ),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
