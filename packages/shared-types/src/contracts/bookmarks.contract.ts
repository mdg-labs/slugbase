import { initContract } from "@ts-rest/core";
import { z } from "zod";

import { BOOKMARK_HTTP_URL_MESSAGE, isBookmarkHttpUrl } from "../validation/bookmark-url.js";

const c = initContract();

const bookmarkUrlField = z
  .string()
  .min(1)
  .max(2048)
  .refine(isBookmarkHttpUrl, { message: BOOKMARK_HTTP_URL_MESSAGE });

const BookmarkFolderSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();

const BookmarkTagSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    color: z.string().nullable(),
  })
  .strict();

export const BookmarkSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    userId: z.string(),
    title: z.string(),
    url: z.string(),
    slug: z.string().nullable(),
    forwardingEnabled: z.boolean(),
    pinned: z.boolean(),
    planArchived: z.boolean(),
    accessCount: z.number().int().nonnegative(),
    lastAccessedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    folders: z.array(BookmarkFolderSummarySchema),
    tags: z.array(BookmarkTagSummarySchema),
  })
  .strict();

export type BookmarkFolderSummary = z.infer<typeof BookmarkFolderSummarySchema>;
export type BookmarkTagSummary = z.infer<typeof BookmarkTagSummarySchema>;

const slugField = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Invalid slug format")
  .nullable()
  .optional();

export const CreateBookmarkBodySchema = z
  .object({
    title: z.string().min(1).max(500),
    url: bookmarkUrlField,
    slug: slugField,
    forwardingEnabled: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

export const UpdateBookmarkBodySchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    url: bookmarkUrlField.optional(),
    slug: slugField,
    forwardingEnabled: z.boolean().optional(),
    pinned: z.boolean().optional(),
    planArchived: z.boolean().optional(),
  })
  .strict();

export const TogglePinBodySchema = z
  .object({
    pinned: z.boolean(),
  })
  .strict();

export const BookmarkListSchema = z
  .object({
    items: z.array(BookmarkSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .strict();

export const BookmarkIdsSchema = z
  .object({
    ids: z.array(z.string()),
    total: z.number().int().nonnegative(),
  })
  .strict();

export const BookmarkListQuerySchema = z
  .object({
    q: z.string().optional(),
    folderId: z.string().optional(),
    tagIds: z.union([z.string(), z.array(z.string())]).optional(),
    pinned: z
      .union([z.literal("true"), z.literal("false")])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
    scope: z
      .enum(["all", "mine", "shared-with-me", "shared-by-me"])
      .optional(),
    sort: z
      .enum([
        "created-desc",
        "title-asc",
        "access-count-desc",
        "last-accessed-desc",
      ])
      .optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
  })
  .strict();

export type Bookmark = z.infer<typeof BookmarkSchema>;
export type BookmarkList = z.infer<typeof BookmarkListSchema>;
export type BookmarkIds = z.infer<typeof BookmarkIdsSchema>;
export type CreateBookmarkBody = z.infer<typeof CreateBookmarkBodySchema>;
export type UpdateBookmarkBody = z.infer<typeof UpdateBookmarkBodySchema>;

export const BookmarkMetadataSchema = z
  .object({
    title: z.string().nullable(),
    description: z.string().nullable(),
    siteName: z.string().nullable(),
    faviconUrl: z.string().nullable(),
  })
  .strict();

export const FetchBookmarkMetadataQuerySchema = z
  .object({
    url: z.string().min(1).max(2048),
  })
  .strict();

export type BookmarkMetadata = z.infer<typeof BookmarkMetadataSchema>;

const bulkListFiltersSchema = BookmarkListQuerySchema.omit({
  page: true,
  pageSize: true,
});

export const BulkSelectionBodySchema = bulkListFiltersSchema
  .extend({
    bookmarkIds: z.array(z.string()).optional(),
    selectAll: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) => {
      const hasIds = (value.bookmarkIds?.length ?? 0) > 0;
      const hasSelectAll = value.selectAll === true;
      return (hasIds || hasSelectAll) && !(hasIds && hasSelectAll);
    },
    { message: "Provide bookmarkIds or selectAll: true, not both" },
  );

export const BulkResultSchema = z
  .object({
    processed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    skippedIds: z.array(z.string()),
  })
  .strict();

export const BulkPinBodySchema = BulkSelectionBodySchema.and(
  z.object({ pinned: z.boolean() }).strict(),
);

export const BulkMoveToFolderBodySchema = BulkSelectionBodySchema.and(
  z.object({ folderId: z.string() }).strict(),
);

export const BulkTagsBodySchema = BulkSelectionBodySchema.and(
  z
    .object({
      tagIds: z.array(z.string()).min(1),
    })
    .strict(),
);

export const BulkAddTagsPreviewSchema = z
  .object({
    total: z.number().int().nonnegative(),
    tags: z.array(
      z
        .object({
          tagId: z.string(),
          alreadyTagged: z.number().int().nonnegative(),
          newlyTagged: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

const errorSchema = z.object({ message: z.string() }).strict();

export const bookmarksContract = c.router({
  listBookmarks: {
    method: "GET",
    path: "/bookmarks",
    query: BookmarkListQuerySchema,
    responses: {
      200: BookmarkListSchema,
      400: errorSchema,
    },
    summary:
      "List bookmarks with filter, sort, and pagination (plan-archived excluded)",
  },
  selectAllBookmarkIds: {
    method: "GET",
    path: "/bookmarks/select-all-ids",
    query: BookmarkListQuerySchema,
    responses: {
      200: BookmarkIdsSchema,
      400: errorSchema,
    },
    summary:
      "Return IDs matching the current list filters for bulk select-all",
  },
  createBookmark: {
    method: "POST",
    path: "/bookmarks",
    body: CreateBookmarkBodySchema,
    responses: {
      201: BookmarkSchema,
      400: errorSchema,
      403: errorSchema,
      409: errorSchema,
    },
    summary: "Create a bookmark in the active workspace",
  },
  getBookmark: {
    method: "GET",
    path: "/bookmarks/:id",
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: BookmarkSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Get a bookmark by ID (owner only)",
  },
  updateBookmark: {
    method: "PATCH",
    path: "/bookmarks/:id",
    pathParams: z.object({ id: z.string() }),
    body: UpdateBookmarkBodySchema,
    responses: {
      200: BookmarkSchema,
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
      409: errorSchema,
    },
    summary: "Update a bookmark (owner only)",
  },
  deleteBookmark: {
    method: "DELETE",
    path: "/bookmarks/:id",
    pathParams: z.object({ id: z.string() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Hard-delete a bookmark and cascade associations (owner only)",
  },
  togglePin: {
    method: "POST",
    path: "/bookmarks/:id/pin",
    pathParams: z.object({ id: z.string() }),
    body: TogglePinBodySchema,
    responses: {
      200: BookmarkSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Set pinned state on a bookmark (owner only)",
  },
  recordAccess: {
    method: "POST",
    path: "/bookmarks/:id/access",
    pathParams: z.object({ id: z.string() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      403: errorSchema,
    },
    summary: "Record bookmark access asynchronously (never blocks)",
  },
  fetchBookmarkMetadata: {
    method: "GET",
    path: "/bookmarks/metadata",
    query: FetchBookmarkMetadataQuerySchema,
    responses: {
      200: BookmarkMetadataSchema,
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
      502: errorSchema,
      504: errorSchema,
    },
    summary:
      "Fetch SSRF-safe page metadata (title, description, site name, favicon URL)",
  },
  fetchBookmarkFavicon: {
    method: "GET",
    path: "/bookmarks/favicon",
    query: FetchBookmarkMetadataQuerySchema,
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: c.type<Uint8Array>(),
      }),
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
      502: errorSchema,
      504: errorSchema,
    },
    summary: "Proxy destination favicon through SSRF-safe fetch",
  },
  bulkDeleteBookmarks: {
    method: "POST",
    path: "/bookmarks/bulk/delete",
    body: BulkSelectionBodySchema,
    responses: {
      200: BulkResultSchema,
      400: errorSchema,
    },
    summary: "Bulk hard-delete owned bookmarks; skips unauthorized IDs",
  },
  bulkPinBookmarks: {
    method: "POST",
    path: "/bookmarks/bulk/pin",
    body: BulkPinBodySchema,
    responses: {
      200: BulkResultSchema,
      400: errorSchema,
    },
    summary: "Bulk set pinned state on owned bookmarks",
  },
  bulkMoveBookmarksToFolder: {
    method: "POST",
    path: "/bookmarks/bulk/move-to-folder",
    body: BulkMoveToFolderBodySchema,
    responses: {
      200: BulkResultSchema,
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Bulk add owned bookmarks to a folder",
  },
  bulkAddTagsToBookmarks: {
    method: "POST",
    path: "/bookmarks/bulk/add-tags",
    body: BulkTagsBodySchema,
    responses: {
      200: BulkResultSchema,
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Bulk add tags to owned bookmarks",
  },
  previewBulkAddTagsToBookmarks: {
    method: "POST",
    path: "/bookmarks/bulk/add-tags/preview",
    body: BulkTagsBodySchema,
    responses: {
      200: BulkAddTagsPreviewSchema,
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Preview tag merge counts before bulk add-tags",
  },
  bulkRemoveTagsFromBookmarks: {
    method: "POST",
    path: "/bookmarks/bulk/remove-tags",
    body: BulkTagsBodySchema,
    responses: {
      200: BulkResultSchema,
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Bulk remove tags from owned bookmarks",
  },
});
