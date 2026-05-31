import {
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Cached AI bookmark-field suggestions (spec §11.2, §16).
 * Keyed by workspace, user, canonical URL, and output language; TTL def §5 (30d).
 */
export const aiSuggestionCache = sqliteTable(
  "ai_suggestion_cache",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    outputLanguage: text("output_language").notNull(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
    detectedLanguage: text("detected_language").notNull(),
    confidence: real("confidence").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("ai_suggestion_cache_key_unique_idx").on(
      t.workspaceId,
      t.userId,
      t.canonicalUrl,
      t.outputLanguage,
    ),
  ],
);
