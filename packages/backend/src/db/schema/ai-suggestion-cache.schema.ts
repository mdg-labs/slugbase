import {
  bigint,
  doublePrecision,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const aiSuggestionCache = pgTable(
  "ai_suggestion_cache",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    outputLanguage: text("output_language").notNull(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    tags: text("tags").notNull(),
    detectedLanguage: text("detected_language").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
