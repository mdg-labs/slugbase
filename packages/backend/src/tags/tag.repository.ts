import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, like, sql, type SQL } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import {
  bookmarkTags as sqliteBookmarkTags,
  tags as sqliteTags,
} from "../db/schema/index.js";
import {
  bookmarkTags as pgBookmarkTags,
  tags as pgTags,
} from "../db/schema/pg-index.js";
import {
  WorkspaceScopedRepository,
  type WorkspaceOwned,
} from "../db/workspace-scoped.repository.js";
import type {
  CreateTagData,
  PaginatedTags,
  ParsedListTagsQuery,
  TagRecord,
  UpdateTagData,
} from "./tag.types.js";
import {
  DEFAULT_TAG_PAGE_SIZE,
  type TagSort,
  parsePage,
  parsePageSize,
} from "./tag.validation.js";

type TagRow = WorkspaceOwned & {
  id: string;
  userId: string;
  name: string;
  color: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
};

function toDate(value: Date | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function escapeLikePattern(q: string): string {
  return q.replace(/[%_\\]/g, "\\$&");
}

function orderByForSort(
  sort: TagSort,
  tagsTable: typeof sqliteTags | typeof pgTags,
  bookmarkTagsTable: typeof sqliteBookmarkTags | typeof pgBookmarkTags,
) {
  switch (sort) {
    case "name-asc":
      return asc(tagsTable.name);
    case "name-desc":
      return desc(tagsTable.name);
    case "created-asc":
      return asc(tagsTable.createdAt);
    case "usage-desc":
      return desc(
        sql`(SELECT count(*) FROM ${bookmarkTagsTable} bt WHERE bt.tag_id = ${tagsTable.id} AND bt.workspace_id = ${tagsTable.workspaceId})`,
      );
    case "usage-asc":
      return asc(
        sql`(SELECT count(*) FROM ${bookmarkTagsTable} bt WHERE bt.tag_id = ${tagsTable.id} AND bt.workspace_id = ${tagsTable.workspaceId})`,
      );
    case "created-desc":
    default:
      return desc(tagsTable.createdAt);
  }
}

export class TagRepository extends WorkspaceScopedRepository<TagRecord> {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- forwards db + dialect
  constructor(db: DrizzleClient, dialect: DbDialect) {
    super(db, dialect);
  }

  async create(
    workspaceId: string,
    userId: string,
    data: CreateTagData,
  ): Promise<TagRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteTags)
        .values({
          id,
          workspaceId,
          userId,
          name: data.name,
          color: data.color ?? null,
          createdAt: new Date(nowMs),
          updatedAt: new Date(nowMs),
        })
        .run();

      const row = sqliteDb
        .select()
        .from(sqliteTags)
        .where(
          and(eq(sqliteTags.id, id), eq(sqliteTags.workspaceId, workspaceId)),
        )
        .get();
      const tag = this.assertOwnership(
        workspaceId,
        row ? await this.toTagRecord(row) : null,
      );
      if (data.bookmarkIds?.length) {
        await this.replaceTagBookmarks(workspaceId, userId, id, data.bookmarkIds);
        const withLinks = await this.findById(workspaceId, id);
        if (!withLinks) throw new Error("Failed to load tag after bookmark links");
        return withLinks;
      }
      return tag;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .insert(pgTags)
      .values({
        id,
        workspaceId,
        userId,
        name: data.name,
        color: data.color ?? null,
        createdAt: nowMs,
        updatedAt: nowMs,
      })
      .returning();
    const row = rows[0];
    const tag = this.assertOwnership(
      workspaceId,
      row ? await this.toTagRecord(row) : null,
    );
    if (data.bookmarkIds?.length) {
      await this.replaceTagBookmarks(workspaceId, userId, id, data.bookmarkIds);
      const withLinks = await this.findById(workspaceId, id);
      if (!withLinks) throw new Error("Failed to load tag after bookmark links");
      return withLinks;
    }
    return tag;
  }

  async findById(workspaceId: string, tagId: string): Promise<TagRecord | null> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteTags)
        .where(
          and(eq(sqliteTags.id, tagId), eq(sqliteTags.workspaceId, workspaceId)),
        )
        .get();
      return row ? await this.toTagRecord(row) : null;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgTags)
      .where(and(eq(pgTags.id, tagId), eq(pgTags.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ? await this.toTagRecord(rows[0]) : null;
  }

  async list(
    workspaceId: string,
    userId: string,
    query: ParsedListTagsQuery,
  ): Promise<PaginatedTags> {
    const sort = query.sort;
    const page = parsePage(query.page);
    const pageSize = parsePageSize(query.pageSize ?? DEFAULT_TAG_PAGE_SIZE);
    const offset = (page - 1) * pageSize;
    const searchPattern =
      query.q && query.q.trim().length > 0
        ? `%${escapeLikePattern(query.q.trim())}%`
        : null;

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const conditions: SQL[] = [
        eq(sqliteTags.workspaceId, workspaceId),
        eq(sqliteTags.userId, userId),
      ];
      if (searchPattern) {
        conditions.push(like(sqliteTags.name, searchPattern));
      }
      const whereClause = and(...conditions);

      const countRow = sqliteDb
        .select({ count: sql<number>`count(*)` })
        .from(sqliteTags)
        .where(whereClause)
        .get();
      const total = countRow?.count ?? 0;

      const rows = sqliteDb
        .select()
        .from(sqliteTags)
        .where(whereClause)
        .orderBy(orderByForSort(sort, sqliteTags, sqliteBookmarkTags))
        .limit(pageSize)
        .offset(offset)
        .all();

      const items = await Promise.all(rows.map((row) => this.toTagRecord(row)));
      return { items, total, page, pageSize };
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const conditions: SQL[] = [
      eq(pgTags.workspaceId, workspaceId),
      eq(pgTags.userId, userId),
    ];
    if (searchPattern) {
      conditions.push(like(pgTags.name, searchPattern));
    }
    const whereClause = and(...conditions);

    const countRows = await pgDb
      .select({ count: sql<number>`count(*)` })
      .from(pgTags)
      .where(whereClause);
    const total = countRows[0]?.count ?? 0;

    const rows = await pgDb
      .select()
      .from(pgTags)
      .where(whereClause)
      .orderBy(orderByForSort(sort, pgTags, pgBookmarkTags))
      .limit(pageSize)
      .offset(offset);

    const items = await Promise.all(rows.map((row) => this.toTagRecord(row)));
    return { items, total, page, pageSize };
  }

  async update(
    workspaceId: string,
    tagId: string,
    patch: UpdateTagData,
  ): Promise<TagRecord | null> {
    const nowMs = Date.now();
    const updates: Record<string, unknown> = { updatedAt: nowMs };

    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.color !== undefined) updates.color = patch.color;

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .update(sqliteTags)
        .set({
          ...updates,
          updatedAt: new Date(nowMs),
        })
        .where(
          and(eq(sqliteTags.id, tagId), eq(sqliteTags.workspaceId, workspaceId)),
        )
        .run();
      return this.findById(workspaceId, tagId);
    }

    await (this.db as PostgresDrizzleClient)
      .update(pgTags)
      .set(updates)
      .where(and(eq(pgTags.id, tagId), eq(pgTags.workspaceId, workspaceId)));

    return this.findById(workspaceId, tagId);
  }

  async delete(workspaceId: string, tagId: string): Promise<void> {
    await this.deleteBookmarkTagLinksForTag(workspaceId, tagId);

    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteTags)
        .where(
          and(eq(sqliteTags.id, tagId), eq(sqliteTags.workspaceId, workspaceId)),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .delete(pgTags)
      .where(and(eq(pgTags.id, tagId), eq(pgTags.workspaceId, workspaceId)));
  }

  async replaceTagBookmarks(
    workspaceId: string,
    _userId: string,
    tagId: string,
    bookmarkIds: string[],
  ): Promise<void> {
    await this.deleteBookmarkTagLinksForTag(workspaceId, tagId);

    const uniqueIds = [...new Set(bookmarkIds)];
    for (const bookmarkId of uniqueIds) {
      await this.insertBookmarkTagLink(workspaceId, tagId, bookmarkId);
    }
  }

  async addBookmarkToTag(
    workspaceId: string,
    _userId: string,
    tagId: string,
    bookmarkId: string,
  ): Promise<void> {
    const exists = await this.hasBookmarkTagLink(
      workspaceId,
      tagId,
      bookmarkId,
    );
    if (exists) return;
    await this.insertBookmarkTagLink(workspaceId, tagId, bookmarkId);
  }

  async removeBookmarkFromTag(
    workspaceId: string,
    tagId: string,
    bookmarkId: string,
  ): Promise<void> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteBookmarkTags)
        .where(
          and(
            eq(sqliteBookmarkTags.workspaceId, workspaceId),
            eq(sqliteBookmarkTags.tagId, tagId),
            eq(sqliteBookmarkTags.bookmarkId, bookmarkId),
          ),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .delete(pgBookmarkTags)
      .where(
        and(
          eq(pgBookmarkTags.workspaceId, workspaceId),
          eq(pgBookmarkTags.tagId, tagId),
          eq(pgBookmarkTags.bookmarkId, bookmarkId),
        ),
      );
  }

  async countTagsForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<number> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select({ count: sql<number>`count(*)` })
        .from(sqliteBookmarkTags)
        .where(
          and(
            eq(sqliteBookmarkTags.workspaceId, workspaceId),
            eq(sqliteBookmarkTags.bookmarkId, bookmarkId),
          ),
        )
        .get();
      return row?.count ?? 0;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select({ count: sql<number>`count(*)` })
      .from(pgBookmarkTags)
      .where(
        and(
          eq(pgBookmarkTags.workspaceId, workspaceId),
          eq(pgBookmarkTags.bookmarkId, bookmarkId),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async listTagIdsForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<string[]> {
    if (this.dialect === "sqlite") {
      const rows = (this.db as SqliteDrizzleClient)
        .select({ tagId: sqliteBookmarkTags.tagId })
        .from(sqliteBookmarkTags)
        .where(
          and(
            eq(sqliteBookmarkTags.workspaceId, workspaceId),
            eq(sqliteBookmarkTags.bookmarkId, bookmarkId),
          ),
        )
        .all();
      return rows.map((r) => r.tagId);
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select({ tagId: pgBookmarkTags.tagId })
      .from(pgBookmarkTags)
      .where(
        and(
          eq(pgBookmarkTags.workspaceId, workspaceId),
          eq(pgBookmarkTags.bookmarkId, bookmarkId),
        ),
      );
    return rows.map((r) => r.tagId);
  }

  async deleteBookmarkTagLinksForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<void> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteBookmarkTags)
        .where(
          and(
            eq(sqliteBookmarkTags.workspaceId, workspaceId),
            eq(sqliteBookmarkTags.bookmarkId, bookmarkId),
          ),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .delete(pgBookmarkTags)
      .where(
        and(
          eq(pgBookmarkTags.workspaceId, workspaceId),
          eq(pgBookmarkTags.bookmarkId, bookmarkId),
        ),
      );
  }

  private async deleteBookmarkTagLinksForTag(
    workspaceId: string,
    tagId: string,
  ): Promise<void> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteBookmarkTags)
        .where(
          and(
            eq(sqliteBookmarkTags.workspaceId, workspaceId),
            eq(sqliteBookmarkTags.tagId, tagId),
          ),
        )
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .delete(pgBookmarkTags)
      .where(
        and(
          eq(pgBookmarkTags.workspaceId, workspaceId),
          eq(pgBookmarkTags.tagId, tagId),
        ),
      );
  }

  private async hasBookmarkTagLink(
    workspaceId: string,
    tagId: string,
    bookmarkId: string,
  ): Promise<boolean> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select({ id: sqliteBookmarkTags.id })
        .from(sqliteBookmarkTags)
        .where(
          and(
            eq(sqliteBookmarkTags.workspaceId, workspaceId),
            eq(sqliteBookmarkTags.tagId, tagId),
            eq(sqliteBookmarkTags.bookmarkId, bookmarkId),
          ),
        )
        .get();
      return row != null;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select({ id: pgBookmarkTags.id })
      .from(pgBookmarkTags)
      .where(
        and(
          eq(pgBookmarkTags.workspaceId, workspaceId),
          eq(pgBookmarkTags.tagId, tagId),
          eq(pgBookmarkTags.bookmarkId, bookmarkId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  private async insertBookmarkTagLink(
    workspaceId: string,
    tagId: string,
    bookmarkId: string,
  ): Promise<void> {
    const id = randomUUID();
    const nowMs = Date.now();

    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .insert(sqliteBookmarkTags)
        .values({
          id,
          workspaceId,
          tagId,
          bookmarkId,
          createdAt: new Date(nowMs),
        })
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient).insert(pgBookmarkTags).values({
      id,
      workspaceId,
      tagId,
      bookmarkId,
      createdAt: nowMs,
    });
  }

  private async countBookmarksOnTag(
    workspaceId: string,
    tagId: string,
  ): Promise<number> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select({ count: sql<number>`count(*)` })
        .from(sqliteBookmarkTags)
        .where(
          and(
            eq(sqliteBookmarkTags.workspaceId, workspaceId),
            eq(sqliteBookmarkTags.tagId, tagId),
          ),
        )
        .get();
      return row?.count ?? 0;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select({ count: sql<number>`count(*)` })
      .from(pgBookmarkTags)
      .where(
        and(
          eq(pgBookmarkTags.workspaceId, workspaceId),
          eq(pgBookmarkTags.tagId, tagId),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  private async toTagRecord(row: TagRow): Promise<TagRecord> {
    const bookmarkCount = await this.countBookmarksOnTag(row.workspaceId, row.id);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      name: row.name,
      color: row.color,
      bookmarkCount,
      createdAt: toDate(row.createdAt),
      updatedAt: toDate(row.updatedAt),
    };
  }
}
