import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

const looseSlugField = z.string().nullable().optional();

export const ImportBookmarkEntrySchema = z
  .object({
    title: z.string(),
    url: z.string(),
    slug: looseSlugField,
    forwardingEnabled: z.boolean().optional(),
    pinned: z.boolean().optional(),
    folders: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export const ImportResultSchema = z
  .object({
    total: z.number().int().nonnegative(),
    successCount: z.number().int().nonnegative(),
    failureCount: z.number().int().nonnegative(),
    skippedSlugCount: z.number().int().nonnegative(),
    capLimitedCount: z.number().int().nonnegative(),
  })
  .strict();

export const ImportJsonBodySchema = z.array(ImportBookmarkEntrySchema);

export const ImportNetscapeHtmlBodySchema = z
  .object({
    html: z.string(),
  })
  .strict();

export type ImportBookmarkEntry = z.infer<typeof ImportBookmarkEntrySchema>;
export type ImportResult = z.infer<typeof ImportResultSchema>;

const errorSchema = z.object({ message: z.string() }).strict();

export const importContract = c.router({
  importJson: {
    method: "POST",
    path: "/import/json",
    body: ImportJsonBodySchema,
    responses: {
      200: ImportResultSchema,
      400: errorSchema,
    },
    summary: "Import bookmarks from a SlugBase JSON export array",
  },
  importNetscapeHtml: {
    method: "POST",
    path: "/import/netscape-html",
    body: ImportNetscapeHtmlBodySchema,
    responses: {
      200: ImportResultSchema,
      400: errorSchema,
    },
    summary: "Import bookmarks from a Netscape-format HTML export (max 5 MB)",
  },
});
