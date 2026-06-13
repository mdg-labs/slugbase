import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

const colorField = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Invalid color format")
  .nullable()
  .optional();

export const TagSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    userId: z.string(),
    name: z.string(),
    color: z.string().nullable(),
    bookmarkCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const TagListSchema = z
  .object({
    items: z.array(TagSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .strict();

export const CreateTagBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    color: colorField,
    bookmarkIds: z.array(z.string()).optional(),
  })
  .strict();

export const UpdateTagBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    color: colorField,
  })
  .strict();

export const SetTagBookmarksBodySchema = z
  .object({
    bookmarkIds: z.array(z.string()),
  })
  .strict();

export const AddBookmarkToTagBodySchema = z
  .object({
    bookmarkId: z.string(),
  })
  .strict();

export const TagListQuerySchema = z
  .object({
    q: z.string().optional(),
    sort: z
      .enum([
        "name-asc",
        "name-desc",
        "created-desc",
        "created-asc",
        "usage-desc",
        "usage-asc",
      ])
      .optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
  })
  .strict();

export type Tag = z.infer<typeof TagSchema>;
export type TagList = z.infer<typeof TagListSchema>;
export type CreateTagBody = z.infer<typeof CreateTagBodySchema>;
export type UpdateTagBody = z.infer<typeof UpdateTagBodySchema>;

const errorSchema = z.object({ message: z.string() }).strict();

export const tagsContract = c.router({
  createTag: {
    method: "POST",
    path: "/tags",
    body: CreateTagBodySchema,
    responses: {
      201: TagSchema,
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Create a user-private tag in the active workspace",
  },
  listTags: {
    method: "GET",
    path: "/tags",
    query: TagListQuerySchema,
    responses: {
      200: TagListSchema,
      400: errorSchema,
    },
    summary: "List the current user's tags with search, sort, and pagination",
  },
  getTag: {
    method: "GET",
    path: "/tags/:id",
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: TagSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Get a tag by ID (owner only)",
  },
  updateTag: {
    method: "PATCH",
    path: "/tags/:id",
    pathParams: z.object({ id: z.string() }),
    body: UpdateTagBodySchema,
    responses: {
      200: TagSchema,
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Update a tag (owner only)",
  },
  deleteTag: {
    method: "DELETE",
    path: "/tags/:id",
    pathParams: z.object({ id: z.string() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Hard-delete a tag and its bookmark associations (owner only)",
  },
  setTagBookmarks: {
    method: "PUT",
    path: "/tags/:id/bookmarks",
    pathParams: z.object({ id: z.string() }),
    body: SetTagBookmarksBodySchema,
    responses: {
      200: TagSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Replace bookmark membership for a tag (owner only)",
  },
  addBookmarkToTag: {
    method: "POST",
    path: "/tags/:id/bookmarks",
    pathParams: z.object({ id: z.string() }),
    body: AddBookmarkToTagBodySchema,
    responses: {
      200: TagSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Add a bookmark to a tag without removing other tag links",
  },
});
