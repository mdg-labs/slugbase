import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

const iconField = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Invalid icon format")
  .nullable()
  .optional();

const colorField = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Invalid color format - expected hex color e.g. #7782f7")
  .nullable()
  .optional();

export const FolderSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    userId: z.string(),
    name: z.string(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
    bookmarkCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const FolderListSchema = z
  .object({
    items: z.array(FolderSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .strict();

export const CreateFolderBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    icon: iconField,
    color: colorField,
    bookmarkIds: z.array(z.string()).optional(),
  })
  .strict();

export const UpdateFolderBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    icon: iconField,
    color: colorField,
  })
  .strict();

export const SetFolderBookmarksBodySchema = z
  .object({
    bookmarkIds: z.array(z.string()),
  })
  .strict();

export const AddBookmarkToFolderBodySchema = z
  .object({
    bookmarkId: z.string(),
  })
  .strict();

export const FolderListQuerySchema = z
  .object({
    q: z.string().optional(),
    scope: z
      .enum(["all", "mine", "shared-with-me", "shared-by-me"])
      .optional(),
    sort: z
      .enum(["name-asc", "name-desc", "created-desc", "created-asc"])
      .optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
  })
  .strict();

export type Folder = z.infer<typeof FolderSchema>;
export type FolderList = z.infer<typeof FolderListSchema>;
export type CreateFolderBody = z.infer<typeof CreateFolderBodySchema>;
export type UpdateFolderBody = z.infer<typeof UpdateFolderBodySchema>;

const errorSchema = z.object({ message: z.string() }).strict();

export const foldersContract = c.router({
  createFolder: {
    method: "POST",
    path: "/folders",
    body: CreateFolderBodySchema,
    responses: {
      201: FolderSchema,
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Create a folder in the active workspace",
  },
  listFolders: {
    method: "GET",
    path: "/folders",
    query: FolderListQuerySchema,
    responses: {
      200: FolderListSchema,
      400: errorSchema,
    },
    summary: "List folders with search, sort, pagination, and scope filter",
  },
  getFolder: {
    method: "GET",
    path: "/folders/:id",
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: FolderSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Get a folder by ID (owner or shared reader)",
  },
  updateFolder: {
    method: "PATCH",
    path: "/folders/:id",
    pathParams: z.object({ id: z.string() }),
    body: UpdateFolderBodySchema,
    responses: {
      200: FolderSchema,
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Update a folder (owner only)",
  },
  deleteFolder: {
    method: "DELETE",
    path: "/folders/:id",
    pathParams: z.object({ id: z.string() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Hard-delete a folder and its bookmark associations (owner only)",
  },
  setFolderBookmarks: {
    method: "PUT",
    path: "/folders/:id/bookmarks",
    pathParams: z.object({ id: z.string() }),
    body: SetFolderBookmarksBodySchema,
    responses: {
      200: FolderSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Replace bookmark membership for a folder (owner only)",
  },
  addBookmarkToFolder: {
    method: "POST",
    path: "/folders/:id/bookmarks",
    pathParams: z.object({ id: z.string() }),
    body: AddBookmarkToFolderBodySchema,
    responses: {
      200: FolderSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Add a bookmark to a folder without removing other folder links",
  },
});
