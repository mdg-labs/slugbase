import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

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
  })
  .strict();

const slugField = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Invalid slug format")
  .nullable()
  .optional();

export const CreateBookmarkBodySchema = z
  .object({
    title: z.string().min(1).max(500),
    url: z.string().min(1).max(2048),
    slug: slugField,
    forwardingEnabled: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

export const UpdateBookmarkBodySchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    url: z.string().min(1).max(2048).optional(),
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
});
