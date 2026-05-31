import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { AiSuggestions } from "@slugbase/shared-types";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../../db/dialect/create-client.js";
import type { DbDialect } from "../../db/dialect/dialect.js";
import { aiSuggestionCache as sqliteAiSuggestionCache } from "../../db/schema/ai-suggestion-cache.schema.js";
import { aiSuggestionCache as pgAiSuggestionCache } from "../../db/schema/ai-suggestion-cache.schema.pg.js";
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
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async findByKey(key: AiSuggestionCacheKey): Promise<CacheRow | null> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const rows = await sqliteDb
        .select({
          title: sqliteAiSuggestionCache.title,
          slug: sqliteAiSuggestionCache.slug,
          tags: sqliteAiSuggestionCache.tags,
          detectedLanguage: sqliteAiSuggestionCache.detectedLanguage,
          confidence: sqliteAiSuggestionCache.confidence,
          createdAt: sqliteAiSuggestionCache.createdAt,
        })
        .from(sqliteAiSuggestionCache)
        .where(this.sqliteKeyWhere(key))
        .limit(1);

      return rows[0] ?? null;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .select({
        title: pgAiSuggestionCache.title,
        slug: pgAiSuggestionCache.slug,
        tags: pgAiSuggestionCache.tags,
        detectedLanguage: pgAiSuggestionCache.detectedLanguage,
        confidence: pgAiSuggestionCache.confidence,
        createdAt: pgAiSuggestionCache.createdAt,
      })
      .from(pgAiSuggestionCache)
      .where(this.pgKeyWhere(key))
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

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      await sqliteDb
        .insert(sqliteAiSuggestionCache)
        .values({
          id,
          workspaceId: key.workspaceId,
          userId: key.userId,
          canonicalUrl: key.canonicalUrl,
          outputLanguage: key.outputLanguage,
          title: suggestions.title,
          slug: suggestions.slug,
          tags: suggestions.tags,
          detectedLanguage: suggestions.detectedLanguage,
          confidence: suggestions.confidence,
          createdAt: new Date(nowMs),
        })
        .onConflictDoUpdate({
          target: [
            sqliteAiSuggestionCache.workspaceId,
            sqliteAiSuggestionCache.userId,
            sqliteAiSuggestionCache.canonicalUrl,
            sqliteAiSuggestionCache.outputLanguage,
          ],
          set: {
            title: suggestions.title,
            slug: suggestions.slug,
            tags: suggestions.tags,
            detectedLanguage: suggestions.detectedLanguage,
            confidence: suggestions.confidence,
            createdAt: new Date(nowMs),
          },
        });
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const tagsJson = JSON.stringify(suggestions.tags);
    await pgDb
      .insert(pgAiSuggestionCache)
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
          pgAiSuggestionCache.workspaceId,
          pgAiSuggestionCache.userId,
          pgAiSuggestionCache.canonicalUrl,
          pgAiSuggestionCache.outputLanguage,
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
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      await sqliteDb
        .delete(sqliteAiSuggestionCache)
        .where(this.sqliteKeyWhere(key));
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb.delete(pgAiSuggestionCache).where(this.pgKeyWhere(key));
  }

  toSuggestions(row: CacheRow): AiSuggestions {
    return rowToSuggestions(row);
  }

  createdAtMs(row: CacheRow): number {
    return toTimestampMs(row.createdAt);
  }

  private sqliteKeyWhere(key: AiSuggestionCacheKey) {
    return and(
      eq(sqliteAiSuggestionCache.workspaceId, key.workspaceId),
      eq(sqliteAiSuggestionCache.userId, key.userId),
      eq(sqliteAiSuggestionCache.canonicalUrl, key.canonicalUrl),
      eq(sqliteAiSuggestionCache.outputLanguage, key.outputLanguage),
    );
  }

  private pgKeyWhere(key: AiSuggestionCacheKey) {
    return and(
      eq(pgAiSuggestionCache.workspaceId, key.workspaceId),
      eq(pgAiSuggestionCache.userId, key.userId),
      eq(pgAiSuggestionCache.canonicalUrl, key.canonicalUrl),
      eq(pgAiSuggestionCache.outputLanguage, key.outputLanguage),
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
