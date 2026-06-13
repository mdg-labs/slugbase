import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { AiSuggestions } from "@slugbase/shared-types";

import type { DrizzleClient } from "../../db/dialect/create-client.js";
import { aiSuggestionCache } from "../../db/schema/index.js";
import type { AiSuggestionCacheKey } from "./ai-suggestion-cache.types.js";

interface CacheRow {
  title: string;
  slug: string;
  tags: string[];
  detectedLanguage: string;
  confidence: number;
  createdAt: Date | number;
}

function toTimestampMs(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}

function rowToSuggestions(row: CacheRow): AiSuggestions {
  return {
    title: row.title,
    slug: row.slug,
    tags: row.tags,
    detectedLanguage: row.detectedLanguage,
    confidence: row.confidence,
  };
}

export class AiSuggestionCacheRepository {
  constructor(private readonly db: DrizzleClient) {}

  async findByKey(key: AiSuggestionCacheKey): Promise<CacheRow | null> {

        const rows = await this.db
      .select({
        title: aiSuggestionCache.title,
        slug: aiSuggestionCache.slug,
        tags: aiSuggestionCache.tags,
        detectedLanguage: aiSuggestionCache.detectedLanguage,
        confidence: aiSuggestionCache.confidence,
        createdAt: aiSuggestionCache.createdAt,
      })
      .from(aiSuggestionCache)
      .where(this.KeyWhere(key))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      ...row,
      tags: parseTagsJson(row.tags),
    };
  }

  async upsert(
    key: AiSuggestionCacheKey,
    suggestions: AiSuggestions,
    nowMs: number,
  ): Promise<void> {
    const id = randomUUID();

        const tagsJson = JSON.stringify(suggestions.tags);
    await this.db
      .insert(aiSuggestionCache)
      .values({
        id,
        workspaceId: key.workspaceId,
        userId: key.userId,
        canonicalUrl: key.canonicalUrl,
        outputLanguage: key.outputLanguage,
        title: suggestions.title,
        slug: suggestions.slug,
        tags: tagsJson,
        detectedLanguage: suggestions.detectedLanguage,
        confidence: suggestions.confidence,
        createdAt: nowMs,
      })
      .onConflictDoUpdate({
        target: [
          aiSuggestionCache.workspaceId,
          aiSuggestionCache.userId,
          aiSuggestionCache.canonicalUrl,
          aiSuggestionCache.outputLanguage,
        ],
        set: {
          title: suggestions.title,
          slug: suggestions.slug,
          tags: tagsJson,
          detectedLanguage: suggestions.detectedLanguage,
          confidence: suggestions.confidence,
          createdAt: nowMs,
        },
      });
  }

  async deleteByKey(key: AiSuggestionCacheKey): Promise<void> {

        await this.db.delete(aiSuggestionCache).where(this.KeyWhere(key));
  }

  toSuggestions(row: CacheRow): AiSuggestions {
    return rowToSuggestions(row);
  }

  createdAtMs(row: CacheRow): number {
    return toTimestampMs(row.createdAt);
  }

  private KeyWhere(key: AiSuggestionCacheKey) {
    return and(
      eq(aiSuggestionCache.workspaceId, key.workspaceId),
      eq(aiSuggestionCache.userId, key.userId),
      eq(aiSuggestionCache.canonicalUrl, key.canonicalUrl),
      eq(aiSuggestionCache.outputLanguage, key.outputLanguage),
    );
  }
}

function parseTagsJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    return [];
  }
}
