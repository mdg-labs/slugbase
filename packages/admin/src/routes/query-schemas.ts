import { z } from "zod";

import {
  ACCOUNT_SORT_FIELDS,
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
} from "@slugbase/db-admin/public-read";

export const paginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional().default(DEFAULT_PAGE),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
  })
  .strict();

export const accountListQuerySchema = paginationQuerySchema.extend({
  sort: z.enum(ACCOUNT_SORT_FIELDS).optional().default("created_at"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
});

export const formatQuerySchema = z
  .object({
    format: z.enum(["json", "csv"]).optional().default("json"),
  })
  .strict();

export const metricsHistoryQuerySchema = paginationQuerySchema.merge(formatQuerySchema);

export function parseQuery<T extends z.ZodTypeAny>(
  schema: T,
  query: Record<string, string | string[] | undefined>,
): z.infer<T> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    normalized[key] = Array.isArray(value) ? (value[0] ?? "") : value;
  }

  const parsed = schema.safeParse(normalized);
  if (!parsed.success) {
    throw parsed.error;
  }

  return parsed.data as z.infer<T>;
}
