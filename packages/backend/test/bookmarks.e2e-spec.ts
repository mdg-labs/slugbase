import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Bookmarks (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let bookmarksService: BookmarksService;
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
