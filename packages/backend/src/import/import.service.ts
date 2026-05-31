import { BadRequestException, Inject, Injectable } from "@nestjs/common";

import { BookmarkRepository } from "../bookmarks/bookmark.repository.js";
import {
  assertSlugValid,
  normalizeOptionalSlug,
  sanitizeBookmarkTitle,
} from "../bookmarks/bookmark.validation.js";
import { DbService } from "../db/db.service.js";
import { EntitlementsService } from "../entitlements/entitlements.service.js";
import { FolderRepository } from "../folders/folder.repository.js";
import { TagRepository } from "../tags/tag.repository.js";
import { WorkspaceDataGuard } from "../workspaces/workspace-data.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { MAX_IMPORT_BOOKMARKS } from "./import.constants.js";
import { ImportNameResolver } from "./import-name.resolver.js";
import type { ImportBookmarkInput, ImportResult } from "./import.types.js";
import {
  assertNetscapeHtmlSize,
  parseImportJsonBody,
} from "./import.validation.js";
import { parseNetscapeHtml } from "./netscape-html.parser.js";

@Injectable()
export class ImportService {
  private readonly bookmarkRepo: BookmarkRepository;
  private readonly folderRepo: FolderRepository;
  private readonly tagRepo: TagRepository;

  constructor(
    @Inject(DbService) private readonly dbService: DbService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(WorkspaceDataGuard) private readonly wsDataGuard: WorkspaceDataGuard,
  ) {
    const db = dbService.getOrm();
    const dialect = dbService.dialect;
    this.bookmarkRepo = new BookmarkRepository(db, dialect);
    this.folderRepo = new FolderRepository(db, dialect);
    this.tagRepo = new TagRepository(db, dialect);
  }

  async importJson(
    workspace: WorkspaceRecord,
    userId: string,
    rawBody: unknown,
  ): Promise<ImportResult> {
    const entries = parseImportJsonBody(rawBody);
    return this.importEntries(workspace, userId, entries);
  }

  async importNetscapeHtml(
    workspace: WorkspaceRecord,
    userId: string,
    html: string,
  ): Promise<ImportResult> {
    assertNetscapeHtmlSize(html);
    const entries = parseNetscapeHtml(html);
    if (entries.length > MAX_IMPORT_BOOKMARKS) {
      throw new BadRequestException(
        `Import exceeds the maximum of ${String(MAX_IMPORT_BOOKMARKS)} bookmarks per request`,
      );
    }
    return this.importEntries(workspace, userId, entries);
  }

  private async importEntries(
    workspace: WorkspaceRecord,
    userId: string,
    entries: ImportBookmarkInput[],
  ): Promise<ImportResult> {
    const result: ImportResult = {
      total: entries.length,
      successCount: 0,
      failureCount: 0,
      skippedSlugCount: 0,
      capLimitedCount: 0,
    };

    if (entries.length === 0) return result;

    const nameResolver = new ImportNameResolver(
      this.dbService.getOrm(),
      this.dbService.dialect,
    );
    const assignedSlugs = new Set<string>();
    let activeCount = await this.bookmarkRepo.countActiveInWorkspace(workspace.id);

    for (const entry of entries) {
      const title = sanitizeBookmarkTitle(entry.title.trim());
      const url = entry.url.trim();

      if (!title || !url) {
        result.failureCount += 1;
        continue;
      }

      if (!this.entitlements.canCreateBookmark(workspace, activeCount)) {
        result.failureCount += 1;
        result.capLimitedCount += 1;
        continue;
      }

      const { slug, skippedSlug } = await this.resolveImportSlug(
        workspace.id,
        entry.slug,
        assignedSlugs,
      );
      if (skippedSlug) result.skippedSlugCount += 1;

      let forwardingEnabled = entry.forwardingEnabled ?? false;
      if (forwardingEnabled && !slug) forwardingEnabled = false;

      try {
        const bookmark = await this.bookmarkRepo.create(workspace.id, userId, {
          title,
          url,
          slug,
          forwardingEnabled,
          pinned: entry.pinned ?? false,
        });
        this.wsDataGuard.verifyOwnership(workspace.id, bookmark);

        if (entry.folders?.length) {
          for (const folderName of entry.folders) {
            const folder = await nameResolver.resolveFolder(
              workspace.id,
              userId,
              folderName,
            );
            if (folder) {
              await this.folderRepo.addBookmarkToFolder(
                workspace.id,
                userId,
                folder.id,
                bookmark.id,
              );
            }
          }
        }

        if (entry.tags?.length) {
          for (const tagName of entry.tags) {
            const tag = await nameResolver.resolveTag(workspace.id, userId, tagName);
            if (tag) {
              await this.tagRepo.addBookmarkToTag(
                workspace.id,
                userId,
                tag.id,
                bookmark.id,
              );
            }
          }
        }

        if (slug) assignedSlugs.add(slug);
        activeCount += 1;
        result.successCount += 1;
      } catch {
        result.failureCount += 1;
      }
    }

    return result;
  }

  private async resolveImportSlug(
    workspaceId: string,
    rawSlug: string | null | undefined,
    assignedSlugs: Set<string>,
  ): Promise<{ slug: string | null; skippedSlug: boolean }> {
    const normalized = normalizeOptionalSlug(rawSlug);
    if (!normalized) return { slug: null, skippedSlug: false };

    try {
      assertSlugValid(normalized);
    } catch {
      return { slug: null, skippedSlug: true };
    }

    if (assignedSlugs.has(normalized)) {
      return { slug: null, skippedSlug: true };
    }

    const existing = await this.bookmarkRepo.findBySlug(workspaceId, normalized);
    if (existing) {
      return { slug: null, skippedSlug: true };
    }

    return { slug: normalized, skippedSlug: false };
  }
}
