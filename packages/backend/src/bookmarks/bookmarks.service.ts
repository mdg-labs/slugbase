import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { DbService } from "../db/db.service.js";
import { AuthzService } from "../common/authz/authz.service.js";
import { EntitlementsService } from "../entitlements/entitlements.service.js";
import { WorkspaceDataGuard } from "../workspaces/workspace-data.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { BookmarkRepository } from "./bookmark.repository.js";
import type {
  BookmarkIdsResult,
  BookmarkRecord,
  CreateBookmarkData,
  ListBookmarksQuery,
  PaginatedBookmarks,
  ParsedListBookmarksQuery,
  UpdateBookmarkData,
} from "./bookmark.types.js";
import {
  assertSlugValid,
  normalizeOptionalSlug,
  parseBookmarkScope,
  parseBookmarkSort,
  parsePinned,
  parseTagIds,
  sanitizeBookmarkTitle,
} from "./bookmark.validation.js";

@Injectable()
export class BookmarksService {
  private readonly repo: BookmarkRepository;

  constructor(
    @Inject(DbService) db: DbService,
    @Inject(WorkspaceDataGuard) private readonly wsDataGuard: WorkspaceDataGuard,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(AuthzService) private readonly authz: AuthzService,
  ) {
    this.repo = new BookmarkRepository(db.getOrm(), db.dialect);
  }

  async createBookmark(
    workspace: WorkspaceRecord,
    userId: string,
    dto: CreateBookmarkData,
  ): Promise<BookmarkRecord> {
    const title = sanitizeBookmarkTitle(dto.title.trim());
    if (!title) throw new BadRequestException("title is required");

    const url = dto.url.trim();
    if (!url) throw new BadRequestException("url is required");

    const slug = normalizeOptionalSlug(dto.slug);
    const forwardingEnabled = dto.forwardingEnabled ?? false;

    this.validateSlugFields(slug, forwardingEnabled);
    await this.assertSlugAvailable(workspace.id, slug, null);

    const activeCount = await this.repo.countActiveInWorkspace(workspace.id);
    this.entitlements.assertCanCreateBookmark(workspace, activeCount);

    return this.repo.create(workspace.id, userId, {
      title,
      url,
      slug,
      forwardingEnabled,
      pinned: dto.pinned ?? false,
    });
  }

  async listBookmarks(
    workspace: WorkspaceRecord,
    userId: string,
    query: ListBookmarksQuery,
  ): Promise<PaginatedBookmarks> {
    const parsed = this.parseListQuery(query);
    const result = await this.repo.list(workspace.id, userId, parsed);
    return {
      ...result,
      items: result.items.map((item) =>
        this.wsDataGuard.verifyOwnership(workspace.id, item),
      ),
    };
  }

  async selectAllBookmarkIds(
    workspace: WorkspaceRecord,
    userId: string,
    query: ListBookmarksQuery,
  ): Promise<BookmarkIdsResult> {
    const parsed = this.parseListQuery(query);
    return this.repo.listIds(workspace.id, userId, parsed);
  }

  async getBookmark(
    workspace: WorkspaceRecord,
    userId: string,
    bookmarkId: string,
  ): Promise<BookmarkRecord> {
    const bookmark = await this.requireReadableBookmark(workspace, userId, bookmarkId);
    return this.wsDataGuard.verifyOwnership(workspace.id, bookmark);
  }

  async updateBookmark(
    workspace: WorkspaceRecord,
    userId: string,
    bookmarkId: string,
    patch: UpdateBookmarkData,
  ): Promise<BookmarkRecord> {
    const existing = await this.requireOwnedBookmark(workspace, userId, bookmarkId);

    const nextTitle =
      patch.title !== undefined ? sanitizeBookmarkTitle(patch.title.trim()) : existing.title;
    if (!nextTitle) throw new BadRequestException("title is required");

    const nextUrl = patch.url !== undefined ? patch.url.trim() : existing.url;
    if (!nextUrl) throw new BadRequestException("url is required");

    const nextSlug =
      patch.slug !== undefined
        ? normalizeOptionalSlug(patch.slug)
        : existing.slug;
    const nextForwarding =
      patch.forwardingEnabled !== undefined
        ? patch.forwardingEnabled
        : existing.forwardingEnabled;

    this.validateSlugFields(nextSlug, nextForwarding);
    await this.assertSlugAvailable(workspace.id, nextSlug, existing.id);

    const updated = await this.repo.update(workspace.id, bookmarkId, {
      title: nextTitle,
      url: nextUrl,
      slug: nextSlug,
      forwardingEnabled: nextForwarding,
      pinned: patch.pinned,
      planArchived: patch.planArchived,
    });

    if (!updated) throw new NotFoundException("Bookmark not found");
    return this.wsDataGuard.verifyOwnership(workspace.id, updated);
  }

  async deleteBookmark(
    workspace: WorkspaceRecord,
    userId: string,
    bookmarkId: string,
  ): Promise<void> {
    await this.requireOwnedBookmark(workspace, userId, bookmarkId);
    await this.repo.delete(workspace.id, bookmarkId);
  }

  async togglePin(
    workspace: WorkspaceRecord,
    userId: string,
    bookmarkId: string,
    pinned: boolean,
  ): Promise<BookmarkRecord> {
    return this.updateBookmark(workspace, userId, bookmarkId, { pinned });
  }

  /**
   * Records bookmark access asynchronously — never blocks the caller (spec §6.3).
   */
  recordAccess(
    workspace: WorkspaceRecord,
    userId: string,
    bookmarkId: string,
  ): void {
    void this.recordAccessAsync(workspace.id, userId, bookmarkId);
  }

  private async recordAccessAsync(
    workspaceId: string,
    userId: string,
    bookmarkId: string,
  ): Promise<void> {
    try {
      const bookmark = await this.repo.findById(workspaceId, bookmarkId);
      if (!bookmark) return;
      const canRead = await this.authz.canReadBookmark(
        workspaceId,
        userId,
        bookmarkId,
        bookmark.userId,
      );
      if (!canRead) return;
      await this.repo.incrementAccessCount(workspaceId, bookmarkId, Date.now());
    } catch {
      // Usage tracking must never surface errors to the caller.
    }
  }

  /** Exposed for integration tests verifying association cascade on hard delete. */
  async createSlugPreferenceForBookmark(
    workspaceId: string,
    userId: string,
    slug: string,
    bookmarkId: string,
  ): Promise<void> {
    await this.repo.createSlugPreference({
      workspaceId,
      userId,
      slug,
      bookmarkId,
    });
  }

  /** Exposed for integration tests verifying association cascade on hard delete. */
  async countSlugPreferencesForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<number> {
    return this.repo.countSlugPreferencesForBookmark(workspaceId, bookmarkId);
  }

  private parseListQuery(query: ListBookmarksQuery): ParsedListBookmarksQuery {
    let scope;
    let sort;
    let pinned;
    try {
      scope = parseBookmarkScope(query.scope);
      sort = parseBookmarkSort(query.sort);
      pinned = parsePinned(query.pinned);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : "Invalid list query",
      );
    }

    return {
      q: query.q,
      folderId: query.folderId,
      tagIds: parseTagIds(query.tagIds),
      pinned,
      scope,
      sort,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async requireReadableBookmark(
    workspace: WorkspaceRecord,
    userId: string,
    bookmarkId: string,
  ): Promise<BookmarkRecord> {
    const bookmark = await this.repo.findById(workspace.id, bookmarkId);
    if (!bookmark) throw new NotFoundException("Bookmark not found");
    this.wsDataGuard.verifyOwnership(workspace.id, bookmark);
    const canRead = await this.authz.canReadBookmark(
      workspace.id,
      userId,
      bookmarkId,
      bookmark.userId,
    );
    if (!canRead) {
      throw new ForbiddenException("Bookmark is not accessible");
    }
    return bookmark;
  }

  private async requireOwnedBookmark(
    workspace: WorkspaceRecord,
    userId: string,
    bookmarkId: string,
  ): Promise<BookmarkRecord> {
    const bookmark = await this.repo.findById(workspace.id, bookmarkId);
    if (!bookmark) throw new NotFoundException("Bookmark not found");
    this.wsDataGuard.verifyOwnership(workspace.id, bookmark);
    if (bookmark.userId !== userId) {
      throw new ForbiddenException("Only the bookmark owner may modify this bookmark");
    }
    return bookmark;
  }

  private validateSlugFields(slug: string | null, forwardingEnabled: boolean): void {
    if (forwardingEnabled && !slug) {
      throw new BadRequestException("slug is required when forwarding is enabled");
    }
    if (slug) {
      try {
        assertSlugValid(slug);
      } catch (err) {
        throw new BadRequestException(
          err instanceof Error ? err.message : "Invalid slug",
        );
      }
    }
  }

  private async assertSlugAvailable(
    workspaceId: string,
    slug: string | null,
    excludeBookmarkId: string | null,
  ): Promise<void> {
    if (!slug) return;

    const existing = await this.repo.findBySlug(workspaceId, slug);
    if (existing && existing.id !== excludeBookmarkId) {
      throw new ConflictException(`Slug "${slug}" is already in use in this workspace`);
    }
  }
}
