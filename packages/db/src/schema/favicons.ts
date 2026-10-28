import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { bytea } from "./types.ts";

// `favicons` of doc 05 section 2.7. Row-level security (enabled and forced, no policy), the missing privileges of `slugbase_app` and the system
// operations that read and write a row live in src/sql/630-favicons.sql, which Drizzle cannot express.

/** What the fetch of a host ended as: its icon was stored, or the host has no icon the server can use. */
export type FaviconStatus = "ok" | "none";

/**
 * The favicon cache of doc 02 section 5.4: one row for each host, shared by the whole deployment (doc 05 section 2.7, doc 10 section 5: it holds
 * hosts, never URLs). `content` is the 64 px PNG and `content_32` the 32 px one, both produced by the server from a source it fetched and decoded;
 * a `none` row records a host with no usable icon and holds neither. A row is current until `expires_at`, seven days after `fetched_at`, and
 * `retention.purge` deletes it after that. The application role reaches the table only through `sys_favicon_get` and `sys_favicon_put`.
 */
export const favicons = pgTable(
  "favicons",
  {
    host: text().primaryKey(),
    content: bytea(),
    content32: bytea("content_32"),
    contentType: text().notNull().default("image/png"),
    status: text().$type<FaviconStatus>().notNull(),
    fetchedAt: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    check("favicons_host_check", sql`length(${table.host}) BETWEEN 1 AND 253 AND ${table.host} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'`),
    check("favicons_status_check", sql`${table.status} IN ('ok', 'none')`),
    check("favicons_content_type_check", sql`${table.contentType} = 'image/png'`),
    check(
      "favicons_content_check",
      sql`(${table.status} = 'ok' AND ${table.content} IS NOT NULL AND ${table.content32} IS NOT NULL AND length(${table.content}) <= 65536 AND length(${table.content32}) <= 65536)
        OR (${table.status} = 'none' AND ${table.content} IS NULL AND ${table.content32} IS NULL)`,
    ),
    index("favicons_expires_idx").on(table.expiresAt),
  ],
);
