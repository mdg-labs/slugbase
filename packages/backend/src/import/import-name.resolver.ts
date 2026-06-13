import { and, eq } from "drizzle-orm";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import {
  folders,
  tags,
} from "../db/schema/index.js";
import { FolderRepository } from "../folders/folder.repository.js";
import type { FolderRecord } from "../folders/folder.types.js";
import { sanitizeFolderName } from "../folders/folder.validation.js";
import { TagRepository } from "../tags/tag.repository.js";
import type { TagRecord } from "../tags/tag.types.js";
import { sanitizeTagName } from "../tags/tag.validation.js";

/** Resolves folder/tag names to existing records or creates new ones for the importing user. */
export class ImportNameResolver {
  private readonly folderRepo: FolderRepository;
  private readonly tagRepo: TagRepository;
  private readonly folderCache = new Map<string, FolderRecord>();
  private readonly tagCache = new Map<string, TagRecord>();

  constructor(private readonly db: DrizzleClient) {
    this.folderRepo = new FolderRepository(db);
    this.tagRepo = new TagRepository(db);
  }

  async resolveFolder(
    workspaceId: string,
    userId: string,
    rawName: string,
  ): Promise<FolderRecord | null> {
    const name = sanitizeFolderName(rawName.trim());
    if (!name) return null;

    const cacheKey = `${workspaceId}:${userId}:${name}`;
    const cached = this.folderCache.get(cacheKey);
    if (cached) return cached;

    const existing = await this.findFolderByName(workspaceId, userId, name);
    if (existing) {
      this.folderCache.set(cacheKey, existing);
      return existing;
    }

    const created = await this.folderRepo.create(workspaceId, userId, { name });
    this.folderCache.set(cacheKey, created);
    return created;
  }

  async resolveTag(
    workspaceId: string,
    userId: string,
    rawName: string,
  ): Promise<TagRecord | null> {
    const name = sanitizeTagName(rawName.trim());
    if (!name) return null;

    const cacheKey = `${workspaceId}:${userId}:${name}`;
    const cached = this.tagCache.get(cacheKey);
    if (cached) return cached;

    const existing = await this.findTagByName(workspaceId, userId, name);
    if (existing) {
      this.tagCache.set(cacheKey, existing);
      return existing;
    }

    const created = await this.tagRepo.create(workspaceId, userId, { name });
    this.tagCache.set(cacheKey, created);
    return created;
  }

  private async findFolderByName(
    workspaceId: string,
    userId: string,
    name: string,
  ): Promise<FolderRecord | null> {

        const rows = await this.db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.workspaceId, workspaceId),
          eq(folders.userId, userId),
          eq(folders.name, name),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? this.folderRepo.findById(workspaceId, row.id) : null;
  }

  private async findTagByName(
    workspaceId: string,
    userId: string,
    name: string,
  ): Promise<TagRecord | null> {

        const rows = await this.db
      .select()
      .from(tags)
      .where(
        and(
          eq(tags.workspaceId, workspaceId),
          eq(tags.userId, userId),
          eq(tags.name, name),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? this.tagRepo.findById(workspaceId, row.id) : null;
  }
}
