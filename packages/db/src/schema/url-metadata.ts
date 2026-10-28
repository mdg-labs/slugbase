import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.ts";

// `url_metadata` of doc 05 section 2.7. Row-level security, the policy and the privileges of `slugbase_app` live in
// src/sql/620-url-metadata.sql.

/** What a fetch of a page ended as: its metadata was read, the page could not be read, or the egress port refused the target. */
export type UrlMetadataStatus = "ok" | "failed" | "blocked";

/**
 * The cache of the page metadata the `bookmark.fetchMetadata` job reads (doc 02 section 5.4), one row for each workspace and canonical URL.
 * It is per workspace on purpose (doc 10 section 5): a deployment-wide cache would let one tenant learn by timing whether another saved a URL.
 * The text columns hold plain text the parser in `@slugbase/core` has cleaned and cut to these limits, and null for a page that gave none or
 * a fetch that did not end `ok`. `canonical_url` is the page's own canonical link, kept as text and never fetched. A row is current until
 * `expires_at`, seven days after `fetched_at`, and `retention.purge` deletes it after that.
 */
export const urlMetadata = pgTable(
  "url_metadata",
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    urlCanonical: text().notNull(),
    status: text().$type<UrlMetadataStatus>().notNull(),
    title: text(),
    description: text(),
    siteName: text(),
    canonicalUrl: text(),
    language: text(),
    fetchedAt: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ name: "url_metadata_pkey", columns: [table.workspaceId, table.urlCanonical] }),
    check("url_metadata_status_check", sql`${table.status} IN ('ok', 'failed', 'blocked')`),
    check("url_metadata_url_check", sql`length(${table.urlCanonical}) <= 2048`),
    check("url_metadata_title_check", sql`length(${table.title}) <= 300`),
    check("url_metadata_description_check", sql`length(${table.description}) <= 1000`),
    check("url_metadata_site_name_check", sql`length(${table.siteName}) <= 100`),
    check("url_metadata_canonical_url_check", sql`length(${table.canonicalUrl}) <= 2048`),
    check("url_metadata_language_check", sql`length(${table.language}) <= 35`),
    check("url_metadata_fields_check", sql`${table.status} = 'ok' OR (${table.title} IS NULL AND ${table.description} IS NULL AND ${table.siteName} IS NULL AND ${table.canonicalUrl} IS NULL AND ${table.language} IS NULL)`),
    index("url_metadata_expires_idx").on(table.expiresAt),
  ],
);
