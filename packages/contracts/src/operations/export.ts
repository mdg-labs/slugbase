import { z } from "zod";
import { BOOKMARK_DESCRIPTION_MAX_LENGTH, BOOKMARK_SCOPES, BOOKMARK_SLUG_MAX_LENGTH, BOOKMARK_TITLE_MAX_LENGTH, BOOKMARK_URL_MAX_LENGTH, BookmarkIdsQuerySchema } from "./bookmarks.ts";
import { defineOperation, problemResponse, rateLimitedResponse, streamResponse } from "./define.ts";
import { FOLDER_COLOR_MAX, FOLDER_COLOR_MIN, FOLDER_NAME_MAX_LENGTH } from "./folders.ts";
import { TAG_NAME_MAX_LENGTH } from "./tags.ts";
import { WORKSPACE_NAME_MAX_LENGTH } from "./workspaces.ts";

// The export tag of doc 04 section 10.9 (doc 02 sections 13.2 and 13.3, doc 05 section 2.4, doc 10 T1 and T2): the caller's own content in the active workspace as one
// versioned document, streamed page by page and never stored on the server. The document is the SlugBase export format: a bookmark carries the names of its folders
// and tags, and the icon and colour of a folder are held once, in `folders`. A bookmark has an export-local `ref` that the entries of `goPreferences` point at; it is
// assigned by position, so two exports of the same content hold the same refs, and it is no identifier of the database. `goPreferences` holds the caller's remembered slug choices (doc 02 section 6.4) as a slug and
// the ref of the caller's own bookmark that the choice names, in the order of the slugs; a choice for a bookmark that is another member's has no ref to name and is not exported. The document holds no usage counts, no
// identifiers and no timestamp but `exportedAt`. Content that is another member's, and content that has no owner, is never in it: the one exception is the list `shared`, which holds the
// bookmarks other members shared with the caller when the request asks for them (`includeShared=true`), as their readable fields only and each flagged as shared; it holds none of the owner's
// tags, folders or pin and nothing of who else the bookmark is shared with, and a bookmark whose share has ended, or that a downgrade of the plan archived, is not in it.
// A selection (doc 02 section 5.8): the request names bookmarks by `id`, or by the filters of the list, and the document then holds those that the caller owns or that are shared with the caller, as below; the shared ones are in `shared` whether or not `includeShared` asks for them.

/** The `format` member of the document. */
export const EXPORT_FORMAT = "slugbase-export";

/** The version of the format this release writes. A later release reads every earlier version and refuses a newer one. */
export const EXPORT_VERSION = 1;

/** The `ref` of a bookmark of the document: `b` and its position from 1. */
export const EXPORT_REF_PATTERN = /^b[1-9][0-9]*$/;

/** The `Content-Disposition` of the answer: an attachment named after the day of the export, holding no workspace name. */
export const EXPORT_DISPOSITION_PATTERN = /^attachment; filename="slugbase-export-\d{4}-\d{2}-\d{2}\.json"$/;

/** The `Content-Type` of the Netscape export: HTML in UTF-8, which the browser that imports the file reads the characters of the file in. */
export const EXPORT_NETSCAPE_CONTENT_TYPE = "text/html; charset=utf-8";

/** The `Content-Disposition` of the Netscape export: an attachment named after the day of the export, holding no workspace name. */
export const EXPORT_NETSCAPE_DISPOSITION_PATTERN = /^attachment; filename="slugbase-export-\d{4}-\d{2}-\d{2}\.html"$/;

/** The longest name of an owner an entry of `shared` holds: the longest display name of an account. */
export const EXPORT_OWNER_NAME_MAX_LENGTH = 100;

export const ExportFolderSchema = z
  .strictObject({
    name: z.string().min(1).max(FOLDER_NAME_MAX_LENGTH).describe("The folder's name, as the caller entered it"),
    icon: z.string().min(1).max(40).describe("The folder's icon, a lucide icon name"),
    color: z.number().int().min(FOLDER_COLOR_MIN).max(FOLDER_COLOR_MAX).describe("The folder's colour, 1 to 8: the number of the --folder-N theme token"),
  })
  .meta({ id: "ExportFolder" });

export const ExportBookmarkSchema = z
  .strictObject({
    ref: z.string().regex(EXPORT_REF_PATTERN).describe("The export-local reference of the bookmark, `b1`, `b2` and so on in the order of the list; the entries of goPreferences name a bookmark by it"),
    url: z.string().min(1).max(BOOKMARK_URL_MAX_LENGTH).describe("The bookmark's address, an http or https URL, as it is stored"),
    title: z.string().min(1).max(BOOKMARK_TITLE_MAX_LENGTH).describe("The bookmark's title"),
    description: z.string().max(BOOKMARK_DESCRIPTION_MAX_LENGTH).nullable().describe("The bookmark's description; null when it has none"),
    slug: z.string().min(1).max(BOOKMARK_SLUG_MAX_LENGTH).nullable().describe("The bookmark's slug; null when it has none"),
    forwarding: z.boolean().describe("Whether /go forwards to the bookmark by its slug; true only for a bookmark with a slug"),
    pinned: z.boolean().describe("Whether the bookmark is pinned"),
    planArchived: z.boolean().describe("Whether a downgrade of the plan archived the bookmark: it is exported with everything else, flagged"),
    folders: z.array(z.string().min(1).max(FOLDER_NAME_MAX_LENGTH)).describe("The names of the caller's folders the bookmark is filed in, sorted by the bytes of the name; each is the name of an entry of the document's folders"),
    tags: z.array(z.string().min(1).max(TAG_NAME_MAX_LENGTH)).describe("The names of the caller's tags the bookmark carries, sorted by the bytes of the name; each is the name of an entry of the document's tags"),
  })
  .meta({ id: "ExportBookmark" });

export const ExportGoPreferenceSchema = z
  .strictObject({
    slug: z.string().min(1).max(BOOKMARK_SLUG_MAX_LENGTH).describe("The slug the caller made a choice for"),
    bookmarkRef: z.string().regex(EXPORT_REF_PATTERN).describe("The ref of the caller's own bookmark in this document's bookmarks that the choice names; never another member's bookmark, which has no ref"),
  })
  .meta({ id: "ExportGoPreference" });

export const ExportSharedBookmarkSchema = z
  .strictObject({
    url: z.string().min(1).max(BOOKMARK_URL_MAX_LENGTH).describe("The bookmark's address, an http or https URL, as it is stored"),
    title: z.string().min(1).max(BOOKMARK_TITLE_MAX_LENGTH).describe("The bookmark's title"),
    description: z.string().max(BOOKMARK_DESCRIPTION_MAX_LENGTH).nullable().describe("The bookmark's description; null when it has none"),
    slug: z.string().min(1).max(BOOKMARK_SLUG_MAX_LENGTH).nullable().describe("The bookmark's slug as its owner set it; null when it has none"),
    ownerName: z.string().min(1).max(EXPORT_OWNER_NAME_MAX_LENGTH).nullable().describe("The display name of the member who owns the bookmark; null when the bookmark has no owner, because its owner has left the workspace"),
    shared: z.literal(true).describe("Always true: the bookmark is another member's, shared with the caller, and a re-import never creates it"),
  })
  .meta({ id: "ExportSharedBookmark" });

/** The most bookmarks an export names by `id`. */
export const EXPORT_SELECTION_IDS_MAX = 100;

/** The name of the header that holds how many bookmarks the export holds. */
export const EXPORT_COUNT_HEADER = "X-Export-Count";

/** The filters of the list that choose a selection, which "select all matching" names; `scope` is one of them. */
export const EXPORT_SELECTION_FILTERS = ["scope", "pinned", "hasSlug", "forwarding", "q", "url", "folderId", "tag"] as const;

const ExportCountHeader = {
  [EXPORT_COUNT_HEADER]: {
    description: "How many bookmarks the file holds when it begins: the caller's own and the ones shared with the caller that the file reads, in the JSON document (`bookmarks` plus `shared`) and in the browser file alike. A bookmark that is in several sections of the browser file counts once",
    schema: z.number().int().min(0),
  },
} as const;

// A selection is the bookmarks the caller names by `id` (at most 100), or the ones the list filters match (at most the select-all cap): the same filters as `GET /bookmarks/ids`, so that "select all matching" exports what it selects.
// `scope` has no default here: no selection parameter at all is the whole export of the caller's own content, and any one of them makes the request a selection, whose scope is `all` when left out, as the list's is.
export const ExportQuerySchema = BookmarkIdsQuerySchema.omit({ scope: true })
  .extend({
    scope: z
      .enum(BOOKMARK_SCOPES)
      .optional()
      .describe(
        "Selects by the filters of the list: whose bookmarks are matched, as the scope of GET /bookmarks says (all, mine, shared_with_me or shared_by_me); all when another filter is given and this one is left out. Any filter makes the request a selection, which holds the caller's own bookmarks that match in full and the ones shared with the caller as their readable fields only, at most 5 000; more are refused with 422",
      ),
    id: z
      .union([z.uuid(), z.array(z.uuid()).max(EXPORT_SELECTION_IDS_MAX)])
      .optional()
      .describe(
        "Selects the bookmarks with these identifiers: repeat the parameter, at most 100 times. The caller's own bookmarks are exported in full and bookmarks shared with the caller as their readable fields only; an identifier that is none of those (another member's bookmark that is not shared with the caller, one of another workspace, a plan-archived bookmark that is shared, or none at all) is ignored, and nothing in the file, the count or the audit event tells it apart from one that never existed. Not combined with the filters",
      ),
    includeShared: z
      .enum(["true", "false"])
      .optional()
      .describe(
        "true adds the bookmarks shared with the caller to the answer, as their readable fields only and flagged as shared (never the owner's tags, folders or pin, nor who else they are shared with); false, the default, holds the caller's own bookmarks alone. Not combined with a selection, which holds the shared bookmarks it names or matches",
      ),
  })
  .refine((query) => query.id === undefined || EXPORT_SELECTION_FILTERS.every((name) => query[name] === undefined), {
    path: ["id"],
    message: "id is not combined with the filters of the list",
  })
  .refine((query) => query.includeShared === undefined || (query.id === undefined && EXPORT_SELECTION_FILTERS.every((name) => query[name] === undefined)), {
    path: ["includeShared"],
    message: "includeShared is not combined with a selection",
  });

export const ExportDocumentSchema = z
  .strictObject({
    format: z.literal(EXPORT_FORMAT).describe("Always slugbase-export: the document is a SlugBase export"),
    version: z.literal(EXPORT_VERSION).describe("The version of the format; a reader refuses a version newer than it supports"),
    exportedAt: z.iso.datetime().describe("When the export began, in UTC: the one timestamp the document holds"),
    workspace: z.strictObject({ name: z.string().min(1).max(WORKSPACE_NAME_MAX_LENGTH).describe("The name of the workspace the content was exported from") }),
    folders: z.array(ExportFolderSchema).describe("Every folder the caller owns, used or not, sorted by the bytes of the name"),
    tags: z.array(z.string().min(1).max(TAG_NAME_MAX_LENGTH)).describe("The name of every tag the caller owns, used or not, sorted by the bytes of the name"),
    bookmarks: z.array(ExportBookmarkSchema).describe("Every bookmark the caller owns, plan-archived ones included and flagged, in the order of their creation"),
    goPreferences: z.array(ExportGoPreferenceSchema).describe("The caller's remembered slug choices whose bookmark is the caller's own and still has the slug and forwards, each as the slug and the ref of that bookmark, sorted by the bytes of the slug; a choice for another member's bookmark is not in it"),
    shared: z.array(ExportSharedBookmarkSchema).describe("The bookmarks other members shared with the caller that the caller can read, plan-archived ones left out, in the order of their creation; empty unless the request asked for them with includeShared=true, and never read by an import"),
  })
  .meta({ id: "ExportDocument" });

export const exportJson = defineOperation({
  method: "get",
  path: "/api/v1/export/json",
  operationId: "exportJson",
  tag: "export",
  summary: "Export my content as SlugBase JSON",
  auth: "member",
  rate: "bulk",
  scope: "read",
  request: { query: ExportQuerySchema },
  responses: {
    200: streamResponse(
      "The caller's own bookmarks, folders and tags in the active workspace as one SlugBase export document, streamed as an attachment and stored nowhere. The list goPreferences holds the caller's remembered slug choices, each as a slug and bookmarkRef, the ref of the caller's own bookmark in the same document that the choice names and that still has the slug and forwards, sorted by slug; a choice for another member's bookmark is never in it, and the document holds no other member's choice. With includeShared=true the list shared also holds the bookmarks other members shared with the caller (directly, through a team or through a shared folder) that the caller can read at the moment each page is read, as url, title, description, slug, ownerName and shared: true and nothing else, so never the owner's tags, folders or pin nor who else the bookmark is shared with; a bookmark whose share has ended, one a downgrade of the plan archived and one of another workspace is not in it. Without it shared is empty. With id (at most 100) or the filters of the list (scope, folderId, tag, pinned, hasSlug, forwarding, q, url) the document holds that selection only: the caller's own bookmarks in bookmarks, in full, and the bookmarks shared with the caller in shared, as their readable fields only; folders and tags hold the ones those own bookmarks use, goPreferences the remembered choices for them, and an identifier of a bookmark the caller cannot read is ignored without a trace in the file, the count or the audit event. A selection by filters is refused with 422 when more than 5 000 bookmarks match. The export is recorded in the workspace's audit log as export.created with counts only (bookmarks, folders, tags and shared), before the first byte. A failure after the first byte ends the connection with the document unfinished, so what was received does not parse as JSON",
      "application/json",
      {
        schema: ExportDocumentSchema,
        headers: {
          "Content-Disposition": {
            description: "An attachment named slugbase-export-<date>.json, the date being the UTC day of the export; the name holds no workspace name",
            schema: z.string().regex(EXPORT_DISPOSITION_PATTERN),
          },
          ...ExportCountHeader,
        },
      },
    ),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The query is not valid (validation_failed): includeShared is neither true nor false, an id or a filter is malformed or more than 100 ids are named, id is combined with a filter, includeShared with a selection, the url is not a URL a bookmark can have, more than 5 000 bookmarks match the filters of a selection, or the request names a parameter the operation does not take"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again. Exports take from the bulk limit"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

// The lossy export for browsers (doc 02 section 13.2, doc 04 sections 7 and 10.9, doc 10 T13 and T14, Q29 and Q33): the same content as a Netscape bookmark file, one section per folder, which a browser
// imports and the Netscape import of this API reads back. It names no field a browser has no place for (the description, the pin, the forwarding flag, the folder's icon and colour), and a bookmark filed
// in several folders is in each of them. The `Content-Type` is `text/html; charset=utf-8` and the answer is an attachment that is never rendered in the origin of the application: a response that is
// not served as an attachment with `nosniff` would let a title run as script there.

export const exportNetscape = defineOperation({
  method: "get",
  path: "/api/v1/export/netscape",
  operationId: "exportNetscape",
  tag: "export",
  summary: "Export my bookmarks as a browser bookmark file",
  auth: "member",
  rate: "bulk",
  scope: "read",
  request: { query: ExportQuerySchema },
  responses: {
    200: streamResponse(
      "The caller's own bookmarks in the active workspace as a Netscape bookmark file (text/html; charset=utf-8) that browsers import, streamed as an attachment and stored nowhere: one level of sections, one per folder, a bookmark that is in several folders under each of them and a bookmark that is in none at the top level. A link carries the bookmark's address, its title, its slug as SHORTCUTURL and its tags, comma-separated, as TAGS; every title, address, folder name, tag and slug is HTML-escaped. Plan-archived bookmarks are included, since the format has no flag for them, and the description, the pin, the forwarding flag and the go preferences are left out. With includeShared=true the bookmarks other members shared with the caller (directly, through a team or through a shared folder) that the caller can read at the moment each page is read are added at the top level, before the first section, with their address, title and slug and no tags, so never the owner's tags or folders; a bookmark whose share has ended, one a downgrade of the plan archived and one of another workspace is not in the file. A tag name that holds a comma is split at it by the format. The export is recorded in the workspace's audit log as export.created with counts only (bookmarks, folders, tags and shared), before the first byte. With id (at most 100) or the filters of the list (scope, folderId, tag, pinned, hasSlug, forwarding, q, url) the file holds that selection only: the caller's own bookmarks under the sections of the folders they are in, the others at the top level, and the bookmarks shared with the caller as above; an identifier of a bookmark the caller cannot read is ignored without a trace in the file, the count or the audit event, and a selection by filters is refused with 422 when more than 5 000 bookmarks match. A failure after the first byte ends the connection with the file unfinished",
      "text/html",
      {
        headers: {
          "Content-Type": {
            description: "text/html with the character set UTF-8, the character set the file is written in",
            schema: z.literal(EXPORT_NETSCAPE_CONTENT_TYPE),
          },
          "Content-Disposition": {
            description: "An attachment named slugbase-export-<date>.html, the date being the UTC day of the export; the name holds no workspace name",
            schema: z.string().regex(EXPORT_NETSCAPE_DISPOSITION_PATTERN),
          },
          ...ExportCountHeader,
        },
      },
    ),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The query is not valid (validation_failed): includeShared is neither true nor false, an id or a filter is malformed or more than 100 ids are named, id is combined with a filter, includeShared with a selection, the url is not a URL a bookmark can have, more than 5 000 bookmarks match the filters of a selection, or the request names a parameter the operation does not take"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again. Exports take from the bulk limit"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
