import { z } from "zod";
import { BOOKMARK_TITLE_MAX_LENGTH, BOOKMARK_URL_MAX_LENGTH } from "./bookmarks.ts";
import { defineOperation, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { EXPORT_VERSION, ExportBookmarkSchema, ExportDocumentSchema } from "./export.ts";

// The import tag of doc 04 section 10.9 (doc 02 sections 13.1 and 13.3, doc 10 T1, T11 and T13): a SlugBase JSON file, the export envelope or a plain array of bookmarks, is read within strict caps
// and the answer says exactly what the import did. With `dryRun=true` it says what the import would do and the operation writes nothing of the workspace; without it, or with `dryRun=false`, the bookmarks are created in one transaction under
// the workspace's `bookmarks.max` and the answer is the result. The request is synchronous, as doc 04 section 10.9 defines it.
//
// A file that is not the format is a `422` for the whole request: a value of the wrong type, a field the format does not declare, more bookmarks than the cap, a version this release does not
// read. A bookmark that is the format but has a bad URL, or a title that is too long, is that bookmark's problem: it is reported in `failed` or cut to its limit, and the rest of the file is
// unaffected. The schemas are strict objects, so a value nested deeper than the format allows is refused before anything reads it.

/** The most bookmarks one import file holds (doc 02 section 13.1). */
export const IMPORT_MAX_BOOKMARKS = 5000;

/** The largest import request body, in bytes (doc 04 section 10.9). */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export const IMPORT_SKIPPED_REASONS = ["duplicate", "bookmark_limit_reached"] as const;
export const IMPORT_FAILED_REASONS = ["url_not_allowed", "url_invalid"] as const;
export const IMPORT_SLUG_DROPPED_REASONS = ["slug_invalid", "slug_conflict"] as const;

export const ImportBookmarkSchema = z
  .strictObject({
    ref: ExportBookmarkSchema.shape.ref.optional(),
    url: z.string().describe("The bookmark's address. It must be an http or https URL once normalised; anything else makes this bookmark a failure, not the file"),
    title: z.string().nullish().describe("The bookmark's title; cut to 300 characters. A missing or blank title becomes the host of the URL"),
    description: z.string().nullish().describe("The bookmark's description; cut to 1 000 characters. A blank one is none"),
    slug: z.string().nullish().describe("The bookmark's slug; a blank one is none. It is trimmed and lower-cased, and it is dropped from the bookmark, which is still imported, when it is outside the slug grammar, the caller has it on a bookmark already (plan-archived or not) or an earlier bookmark of the file that is imported keeps it"),
    forwarding: z.boolean().optional().describe("Whether /go forwards to the bookmark by its slug; off when left out, and off for a bookmark that has no slug or loses it"),
    pinned: z.boolean().optional().describe("Whether the bookmark is pinned"),
    planArchived: z.boolean().optional().describe("Whether a downgrade of the plan archived the bookmark when the file was made; it is ignored"),
    folders: z.array(z.string()).optional().describe("The names of the folders the bookmark is filed in; a folder the caller has under that name, without regard to case, is used, and any other is created. A name is not split at a slash"),
    tags: z.array(z.string()).optional().describe("The names of the tags the bookmark carries; a tag the caller has under that name, without regard to case, is used, and any other is created"),
  })
  .meta({ id: "ImportBookmark" });

const ImportFolderSchema = z
  .strictObject({
    name: z.string().describe("The folder's name; control characters are removed and it is cut to 64 characters, and a name that is empty then is ignored"),
    icon: z.string().optional().describe("The folder's icon, taken by a folder the import creates; one outside the list a folder may carry becomes the default icon. A folder the caller has keeps its own"),
    color: z.number().int().optional().describe("The folder's colour, 1 to 8, taken by a folder the import creates; any other value becomes the default colour. A folder the caller has keeps its own"),
  })
  .meta({ id: "ImportFolder" });

const ImportBookmarksSchema = z.array(ImportBookmarkSchema).max(IMPORT_MAX_BOOKMARKS).describe("The bookmarks of the file, at most 5 000");

/** The export document of doc 02 section 13.3 as the import reads it: what is required is the format, the version and the bookmarks. */
export const ImportEnvelopeSchema = z
  .strictObject({
    format: ExportDocumentSchema.shape.format,
    version: z.number().int().min(1).max(EXPORT_VERSION).describe(`The version of the format; a version newer than ${String(EXPORT_VERSION)} is refused with 422 and an error at version`),
    exportedAt: ExportDocumentSchema.shape.exportedAt.optional(),
    workspace: ExportDocumentSchema.shape.workspace.optional(),
    folders: z.array(ImportFolderSchema).optional().describe("The folders of the file: each exists after the import, used by a bookmark or not. The caller's folder of that name, without regard to case, is used; any other is created"),
    tags: z.array(z.string()).optional().describe("The tags of the file: each exists after the import, used by a bookmark or not, by the same rules as the folders. Control characters are removed and a name is cut to 40 characters"),
    bookmarks: ImportBookmarksSchema,
    goPreferences: z.array(z.string()).max(0).optional().describe("The caller's remembered slug choices; always empty in a version 1 file"),
    shared: z.array(z.string()).max(0).optional().describe("The bookmarks other members shared with the exporter; always empty in a version 1 file, and never read"),
  })
  .meta({ id: "ImportEnvelope" });

export const ImportRequestSchema = z.union([ImportEnvelopeSchema, ImportBookmarksSchema]).describe("A SlugBase export document, or a plain array of bookmarks");

const QueryBooleanSchema = z.enum(["true", "false"]);

export const ImportQuerySchema = z.strictObject({
  dryRun: QueryBooleanSchema.optional().describe("true answers what the import would do and writes nothing; false, the default, imports the file"),
  skipDuplicates: QueryBooleanSchema.optional().describe("true, the default, skips a bookmark whose canonical URL the caller has already or that an earlier bookmark of the file has; false imports it"),
});

const ImportEntryFields = {
  position: z.number().int().min(1).describe("The place of the bookmark in the file, counted from 1"),
  title: z.string().max(BOOKMARK_TITLE_MAX_LENGTH).describe("The bookmark's title, cut to 300 characters; empty for a bookmark whose URL failed and that had no title"),
  url: z.string().max(BOOKMARK_URL_MAX_LENGTH).describe("The bookmark's address, cut to 2 048 characters"),
};

export const ImportSkippedSchema = z
  .strictObject({ ...ImportEntryFields, reason: z.enum(IMPORT_SKIPPED_REASONS).describe("duplicate: the caller has a bookmark with this canonical URL or an earlier bookmark of the file has; bookmark_limit_reached: the workspace has no room left") })
  .meta({ id: "ImportSkipped" });

export const ImportFailedSchema = z
  .strictObject({ ...ImportEntryFields, reason: z.enum(IMPORT_FAILED_REASONS).describe("url_not_allowed: not an http or https URL; url_invalid: empty, over-long or malformed") })
  .meta({ id: "ImportFailed" });

export const ImportDroppedSlugSchema = z
  .strictObject({
    ...ImportEntryFields,
    slug: z.string().max(BOOKMARK_URL_MAX_LENGTH).describe("The slug that was dropped, cut to 2 048 characters"),
    reason: z.enum(IMPORT_SLUG_DROPPED_REASONS).describe("slug_invalid: outside the slug grammar; slug_conflict: the caller has a bookmark with it already, plan-archived or not, or an earlier bookmark of the file that is imported keeps it"),
  })
  .meta({ id: "ImportDroppedSlug" });

export const ImportResultSchema = z
  .strictObject({
    detected: z
      .strictObject({
        bookmarks: z.number().int().min(0).describe("The bookmarks in the file"),
        folders: z.number().int().min(0).describe("The distinct folder names in the file, compared without regard to case"),
        tags: z.number().int().min(0).describe("The distinct tag names in the file, compared without regard to case"),
      })
      .describe("What the file holds"),
    created: z.number().int().min(0).describe("The bookmarks the import creates (with dryRun=true, would create)"),
    skipped: z.array(ImportSkippedSchema).describe("The bookmarks the import leaves out, in the order of the file"),
    failed: z.array(ImportFailedSchema).describe("The bookmarks whose URL the import refuses, in the order of the file"),
    slugsDropped: z.number().int().min(0).describe("The bookmarks that lose their slug (with dryRun=true, would lose it)"),
    droppedSlugs: z.array(ImportDroppedSlugSchema).describe("The slugs that are dropped, in the order of the file"),
    foldersCreated: z.number().int().min(0).describe("The folders the import creates (with dryRun=true, would create): those of the file and of the bookmarks that are imported that the caller does not have"),
    tagsCreated: z.number().int().min(0).describe("The tags the import creates (with dryRun=true, would create), by the same rule"),
  })
  .meta({ id: "ImportResult" });

export const importJson = defineOperation({
  method: "post",
  path: "/api/v1/import/json",
  operationId: "importJson",
  tag: "import",
  summary: "Import SlugBase JSON",
  auth: "member",
  rate: "bulk",
  scope: "write",
  idempotency: true,
  maxBodyBytes: IMPORT_MAX_BYTES,
  request: { query: ImportQuerySchema, body: ImportRequestSchema },
  responses: {
    200: jsonResponse(
      "What the import did, or with dryRun=true what it would do and nothing is written: the counts of what the file holds, the number of bookmarks created, the bookmarks left out (duplicate by canonical URL, or bookmark_limit_reached for those past the room the workspace had left under its bookmarks.max, read from the workspace's counter) and the bookmarks whose URL is refused, the slugs dropped and the folders and tags created. The bookmarks are created in the order of the file, each filed in its own folders, tagged with its own tags and with its slug, forwarding and pinned state, in one transaction with the counter, the folders, the tags and one import.completed audit event, so a failure leaves none of them. Folders and tags are matched among the caller's own by name, without regard to case, and created when missing; an existing one keeps its icon and colour, and the folders and tags the file lists exist afterwards whether a bookmark uses them or not. A slug outside the grammar, one the caller has already or one an earlier bookmark of the file keeps is dropped from its bookmark with forwarding off, and the bookmark is still imported; a slug the caller takes on another bookmark in a request that runs at the same time is dropped the same way. Every URL is checked as a bookmark's URL is, so only http and https are accepted; control characters are removed from all text, titles and descriptions are cut to their limits, and all text is plain text. A plan-archived flag in the file is ignored. Sent with an Idempotency-Key, the answer is stored under it for 24 hours and replayed with Idempotency-Replayed: true",
      ImportResultSchema,
    ),
    400: problemResponse("The body is not valid JSON, or the Idempotency-Key header is not a UUID"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    409: problemResponse("The Idempotency-Key was used before for another request (idempotency_conflict)"),
    413: problemResponse("The request body is over 5 MiB (payload_too_large)"),
    422: problemResponse(
      "The body is not a SlugBase JSON file (validation_failed; errors holds at most 100 entries naming the path and the code of each): a value of the wrong type, a field the format does not declare, more than 5 000 bookmarks, a format other than slugbase-export, or a version newer than this release reads, which is an error at version. A bad URL or an over-long title is no reason for it: see the answer",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again. Imports take from the bulk limit"),
    503: problemResponse("The service is temporarily unavailable, the entitlement source could not say how many bookmarks the workspace may hold, or an earlier request with the same Idempotency-Key is still running"),
  },
});

export type ImportFileBookmark = z.infer<typeof ImportBookmarkSchema>;
export type ImportRequest = z.infer<typeof ImportRequestSchema>;
export type ImportResult = z.infer<typeof ImportResultSchema>;
