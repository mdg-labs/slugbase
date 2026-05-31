import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { FoldersService } from "../src/folders/folders.service.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import { TagsService } from "../src/tags/tags.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Bookmarks (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let bookmarksService: BookmarksService;
  let foldersService: FoldersService;
  let tagsService: TagsService;
  let workspacesService: WorkspacesService;
  let membersService: WorkspaceMembersService;

  let ownerUserId: string;
  let memberUserId: string;
  let workspaceId: string;
  let workspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    await runMigrations(testDatabase.databaseUrl);
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const accountsService = moduleRef.get(AccountsService);
    bookmarksService = moduleRef.get(BookmarksService);
    foldersService = moduleRef.get(FoldersService);
    tagsService = moduleRef.get(TagsService);
    workspacesService = moduleRef.get(WorkspacesService);
    membersService = moduleRef.get(WorkspaceMembersService);

    const owner = await accountsService.registerAccount({
      email: "bookmark-owner@example.com",
      name: "Bookmark Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const member = await accountsService.registerAccount({
      email: "bookmark-member@example.com",
      name: "Bookmark Member",
      password: "password-abc-123",
    });
    memberUserId = member.id;

    const ws = await workspacesService.createWorkspace(
      { name: "Bookmark Workspace", slug: "bookmark-ws" },
      ownerUserId,
    );
    workspaceId = ws.id;
    workspace = ws;

    await membersService.addMember(workspaceId, memberUserId, "MEMBER", ownerUserId);
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  describe("CRUD + ownership", () => {
    let bookmarkId: string;

    it("creates a bookmark with defaults", async () => {
      const bookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Example Site",
        url: "https://example.com",
      });

      expect(bookmark.id).toBeTruthy();
      expect(bookmark.workspaceId).toBe(workspaceId);
      expect(bookmark.userId).toBe(ownerUserId);
      expect(bookmark.title).toBe("Example Site");
      expect(bookmark.url).toBe("https://example.com");
      expect(bookmark.slug).toBeNull();
      expect(bookmark.forwardingEnabled).toBe(false);
      expect(bookmark.pinned).toBe(false);
      expect(bookmark.planArchived).toBe(false);
      expect(bookmark.accessCount).toBe(0);
      expect(bookmark.lastAccessedAt).toBeNull();
      bookmarkId = bookmark.id;
    });

    it("reads the bookmark for the owner", async () => {
      const bookmark = await bookmarksService.getBookmark(
        workspace,
        ownerUserId,
        bookmarkId,
      );
      expect(bookmark.id).toBe(bookmarkId);
    });

    it("rejects read by a non-owner workspace member", async () => {
      await expect(
        bookmarksService.getBookmark(workspace, memberUserId, bookmarkId),
      ).rejects.toThrow("Only the bookmark owner");
    });

    it("updates bookmark fields", async () => {
      const updated = await bookmarksService.updateBookmark(
        workspace,
        ownerUserId,
        bookmarkId,
        {
          title: "Updated Site",
          slug: "example",
          forwardingEnabled: true,
        },
      );
      expect(updated.title).toBe("Updated Site");
      expect(updated.slug).toBe("example");
      expect(updated.forwardingEnabled).toBe(true);
    });

    it("toggles pin state", async () => {
      const pinned = await bookmarksService.togglePin(
        workspace,
        ownerUserId,
        bookmarkId,
        true,
      );
      expect(pinned.pinned).toBe(true);

      const unpinned = await bookmarksService.togglePin(
        workspace,
        ownerUserId,
        bookmarkId,
        false,
      );
      expect(unpinned.pinned).toBe(false);
    });

    it("rejects update by a non-owner workspace member", async () => {
      await expect(
        bookmarksService.updateBookmark(workspace, memberUserId, bookmarkId, {
          title: "Hijacked",
        }),
      ).rejects.toThrow("Only the bookmark owner");
    });

    it("rejects duplicate slug within the workspace", async () => {
      await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Other",
        url: "https://other.example.com",
        slug: "other-slug",
      });

      await expect(
        bookmarksService.createBookmark(workspace, ownerUserId, {
          title: "Dup",
          url: "https://dup.example.com",
          slug: "example",
          forwardingEnabled: true,
        }),
      ).rejects.toThrow('Slug "example" is already in use');
    });
  });

  describe("async usage tracking", () => {
    it("increments access count without blocking the caller", async () => {
      const bookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Usage Test",
        url: "https://usage.example.com",
      });

      bookmarksService.recordAccess(workspace, ownerUserId, bookmark.id);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const updated = await bookmarksService.getBookmark(
        workspace,
        ownerUserId,
        bookmark.id,
      );
      expect(updated.accessCount).toBeGreaterThanOrEqual(1);
      expect(updated.lastAccessedAt).not.toBeNull();
    });
  });

  describe("listing filter, sort, pagination, select-all-ids", () => {
    let folderId: string;
    let tagAId: string;
    let tagBId: string;
    let alphaId: string;
    let betaId: string;
    let gammaId: string;
    let archivedId: string;

    beforeAll(async () => {
      const folder = await foldersService.createFolder(workspace, ownerUserId, {
        name: "List Filter Folder",
      });
      folderId = folder.id;

      const tagA = await tagsService.createTag(workspace, ownerUserId, {
        name: "list-alpha-tag",
      });
      tagAId = tagA.id;
      const tagB = await tagsService.createTag(workspace, ownerUserId, {
        name: "list-beta-tag",
      });
      tagBId = tagB.id;

      const alpha = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Alpha Docs",
        url: "https://alpha.example.com",
        slug: "alpha-docs",
        pinned: true,
      });
      alphaId = alpha.id;
      await foldersService.addBookmarkToFolder(
        workspace,
        ownerUserId,
        folderId,
        alphaId,
      );
      await tagsService.addBookmarkToTag(workspace, ownerUserId, tagAId, alphaId);
      await tagsService.addBookmarkToTag(workspace, ownerUserId, tagBId, alphaId);

      const beta = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Beta Guide",
        url: "https://beta.example.com/guide",
      });
      betaId = beta.id;
      await foldersService.addBookmarkToFolder(
        workspace,
        ownerUserId,
        folderId,
        betaId,
      );
      await tagsService.addBookmarkToTag(workspace, ownerUserId, tagAId, betaId);

      const gamma = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Gamma Notes",
        url: "https://gamma.example.com",
      });
      gammaId = gamma.id;
      bookmarksService.recordAccess(workspace, ownerUserId, gammaId);
      bookmarksService.recordAccess(workspace, ownerUserId, gammaId);
      await new Promise((resolve) => setTimeout(resolve, 150));
      bookmarksService.recordAccess(workspace, ownerUserId, betaId);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const archived = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Archived Hidden",
        url: "https://archived.example.com",
      });
      archivedId = archived.id;
      await bookmarksService.updateBookmark(workspace, ownerUserId, archivedId, {
        planArchived: true,
      });
    });

    it("filters by folder, tags (AND), pinned, and search query", async () => {
      const inFolder = await bookmarksService.listBookmarks(workspace, ownerUserId, {
        folderId,
      });
      expect(inFolder.total).toBeGreaterThanOrEqual(2);
      expect(inFolder.items.map((b) => b.id).sort()).toEqual(
        [alphaId, betaId].sort(),
      );
      expect(inFolder.items.every((b) => !b.planArchived)).toBe(true);

      const bothTags = await bookmarksService.listBookmarks(workspace, ownerUserId, {
        tagIds: [tagAId, tagBId],
      });
      expect(bothTags.items.map((b) => b.id)).toEqual([alphaId]);

      const pinnedOnly = await bookmarksService.listBookmarks(workspace, ownerUserId, {
        pinned: true,
      });
      expect(pinnedOnly.items.some((b) => b.id === alphaId)).toBe(true);
      expect(pinnedOnly.items.every((b) => b.pinned)).toBe(true);

      const search = await bookmarksService.listBookmarks(workspace, ownerUserId, {
        q: "beta",
      });
      expect(search.items.map((b) => b.id)).toEqual([betaId]);
    });

    it("excludes plan-archived bookmarks from list and select-all-ids", async () => {
      const list = await bookmarksService.listBookmarks(workspace, ownerUserId, {});
      expect(list.items.some((b) => b.id === archivedId)).toBe(false);

      const ids = await bookmarksService.selectAllBookmarkIds(
        workspace,
        ownerUserId,
        {},
      );
      expect(ids.ids).not.toContain(archivedId);
    });

    it("sorts by title, access count, and last accessed", async () => {
      const byTitle = await bookmarksService.listBookmarks(workspace, ownerUserId, {
        sort: "title-asc",
        pageSize: 50,
      });
      const titles = byTitle.items.map((b) => b.title);
      const sorted = [...titles].sort((a, b) => a.localeCompare(b));
      expect(titles).toEqual(sorted);

      const gamma = await bookmarksService.getBookmark(workspace, ownerUserId, gammaId);
      const beta = await bookmarksService.getBookmark(workspace, ownerUserId, betaId);
      expect(gamma.accessCount).toBeGreaterThan(beta.accessCount);
      if (gamma.lastAccessedAt == null || beta.lastAccessedAt == null) {
        throw new Error("expected last accessed timestamps");
      }
      expect(gamma.lastAccessedAt.getTime()).toBeLessThan(beta.lastAccessedAt.getTime());

      const byUsage = await bookmarksService.listBookmarks(workspace, ownerUserId, {
        folderId,
        sort: "access-count-desc",
      });
      expect(byUsage.items[0]?.id).toBe(betaId);

      const byAccessed = await bookmarksService.listBookmarks(workspace, ownerUserId, {
        folderId,
        sort: "last-accessed-desc",
      });
      expect(byAccessed.items[0]?.id).toBe(betaId);
    });

    it("paginates results with stable totals", async () => {
      const page1 = await bookmarksService.listBookmarks(workspace, ownerUserId, {
        page: 1,
        pageSize: 2,
        sort: "title-asc",
      });
      expect(page1.items).toHaveLength(2);
      expect(page1.page).toBe(1);
      expect(page1.pageSize).toBe(2);
      expect(page1.total).toBeGreaterThanOrEqual(3);

      const page2 = await bookmarksService.listBookmarks(workspace, ownerUserId, {
        page: 2,
        pageSize: 2,
        sort: "title-asc",
      });
      expect(page2.items.length).toBeGreaterThanOrEqual(1);
      const page1Ids = new Set(page1.items.map((b) => b.id));
      expect(page2.items.every((b) => !page1Ids.has(b.id))).toBe(true);
    });

    it("select-all-ids matches list filters across pages", async () => {
      const list = await bookmarksService.listBookmarks(workspace, ownerUserId, {
        folderId,
        sort: "title-asc",
      });
      const allIds = await bookmarksService.selectAllBookmarkIds(
        workspace,
        ownerUserId,
        { folderId, sort: "title-asc" },
      );
      expect(allIds.total).toBe(list.total);
      expect(allIds.ids.sort()).toEqual(list.items.map((b) => b.id).sort());
    });
  });

  describe("hard delete cascades associations", () => {
    it("removes slug preferences when the bookmark is deleted", async () => {
      const bookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Cascade Test",
        url: "https://cascade.example.com",
        slug: "cascade-test",
        forwardingEnabled: true,
      });

      await bookmarksService.createSlugPreferenceForBookmark(
        workspaceId,
        ownerUserId,
        "cascade-test",
        bookmark.id,
      );

      expect(
        await bookmarksService.countSlugPreferencesForBookmark(workspaceId, bookmark.id),
      ).toBe(1);

      await bookmarksService.deleteBookmark(workspace, ownerUserId, bookmark.id);

      expect(
        await bookmarksService.countSlugPreferencesForBookmark(workspaceId, bookmark.id),
      ).toBe(0);

      await expect(
        bookmarksService.getBookmark(workspace, ownerUserId, bookmark.id),
      ).rejects.toThrow("Bookmark not found");
    });
  });
});
