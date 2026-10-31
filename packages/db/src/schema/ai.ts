import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaceMembers } from "./workspaces.ts";

// `ai_suggestions` and `ai_suggestion_usage` of doc 05 section 2.8. Row-level security, the policies and the privileges of `slugbase_app` live in
// src/sql/690-ai-suggestions.sql.

/** What the cache holds for a suggestion: the answer of the provider once it has passed the checks of `@slugbase/core`. A slug the grammar refused is null. */
export interface StoredAiSuggestion {
  readonly title: string;
  readonly slug: string | null;
  readonly tags: readonly string[];
  readonly confidence: number;
}

/**
 * The cache of AI suggestions (doc 02 section 14), one row for each member, workspace, canonical URL and language. A suggestion is built from the member's
 * own tag names, so the key names the member as well as the workspace and the policy confines a row to both: a row is never served to another member or
 * another workspace (doc 10 T1 and T11). The key does not hold the page metadata the request sent, so a later request for the same key is served the same
 * suggestion whatever metadata it sends. `provider` and `model` name what answered, and the row is current until `expires_at`, 30 days after `created_at`;
 * `retention.purge` deletes it after that. The member's key goes with the member by foreign key.
 */
export const aiSuggestions = pgTable(
  "ai_suggestions",
  {
    workspaceId: uuid().notNull(),
    accountId: uuid().notNull(),
    urlCanonical: text().notNull(),
    locale: text().notNull(),
    result: jsonb().$type<StoredAiSuggestion>().notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ name: "ai_suggestions_pkey", columns: [table.workspaceId, table.accountId, table.urlCanonical, table.locale] }),
    foreignKey({
      name: "ai_suggestions_member_fkey",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.accountId],
    }).onDelete("cascade"),
    check("ai_suggestions_url_check", sql`length(${table.urlCanonical}) <= 2048`),
    check("ai_suggestions_locale_check", sql`length(${table.locale}) BETWEEN 2 AND 35`),
    check("ai_suggestions_result_check", sql`${table.result} @> '{}'::jsonb`),
    check("ai_suggestions_provider_check", sql`length(${table.provider}) BETWEEN 1 AND 200`),
    check("ai_suggestions_model_check", sql`length(${table.model}) BETWEEN 1 AND 200`),
    index("ai_suggestions_expires_idx").on(table.expiresAt),
  ],
);

/**
 * How often each field of a bookmark came from a suggestion the member accepted (doc 02 section 14): one row for each save that named fields, holding
 * which of `title`, `slug` and `tags` they were and never what they held. `bookmark_id` names the bookmark the save wrote and has no key, so a count
 * outlives a deleted bookmark; the row is purged after 90 days. The member's rows go with the member by foreign key.
 */
export const aiSuggestionUsage = pgTable(
  "ai_suggestion_usage",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid().notNull(),
    accountId: uuid().notNull(),
    bookmarkId: uuid(),
    fieldsUsed: text().array().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "ai_suggestion_usage_member_fkey",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.accountId],
    }).onDelete("cascade"),
    check("ai_suggestion_usage_fields_check", sql`${table.fieldsUsed}[1] IS NOT NULL AND ${table.fieldsUsed}[4] IS NULL AND ${table.fieldsUsed} <@ ARRAY['title', 'slug', 'tags']::text[]`),
    index("ai_suggestion_usage_created_idx").on(table.createdAt),
    index("ai_suggestion_usage_member_idx").on(table.workspaceId, table.accountId),
  ],
);
