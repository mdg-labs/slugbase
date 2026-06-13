import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

import { MAX_IMPORT_BOOKMARKS, MAX_NETSCAPE_HTML_BYTES } from "./import.constants.js";
import type { ImportBookmarkInput } from "./import.types.js";

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

export const ImportJsonBodySchema = z
  .array(ImportBookmarkEntrySchema)
  .max(MAX_IMPORT_BOOKMARKS);

export function parseImportJsonBody(raw: unknown): ImportBookmarkInput[] {
  const parsed = ImportJsonBodySchema.safeParse(raw);
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some(
      (issue) => issue.code === "too_big" && issue.path.length === 0,
    );
    if (tooMany) {
      throw new BadRequestException(
        `Import exceeds the maximum of ${String(MAX_IMPORT_BOOKMARKS)} bookmarks per request`,
      );
    }
    throw new BadRequestException("Import JSON must be an array of bookmark objects");
  }
  return parsed.data;
}

export function assertNetscapeHtmlSize(html: string): void {
  const byteLength = Buffer.byteLength(html, "utf8");
  if (byteLength > MAX_NETSCAPE_HTML_BYTES) {
    throw new BadRequestException("Netscape HTML import exceeds the 5 MB size limit");
  }
}
