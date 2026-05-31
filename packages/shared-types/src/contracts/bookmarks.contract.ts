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

export type Bookmark = z.infer<typeof BookmarkSchema>;
export type CreateBookmarkBody = z.infer<typeof CreateBookmarkBodySchema>;
export type UpdateBookmarkBody = z.infer<typeof UpdateBookmarkBodySchema>;

const errorSchema = z.object({ message: z.string() }).strict();

export const bookmarksContract = c.router({
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
});
