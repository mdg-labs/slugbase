import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BulkBookmarksService } from "../src/bookmarks/bulk/bulk.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { FoldersService } from "../src/folders/folders.service.js";
import { TagsService } from "../src/tags/tags.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Bookmark bulk actions (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let bulkService: BulkBookmarksService;
  let bookmarksService: BookmarksService;
  let foldersService: FoldersService;
  let tagsService: TagsService;
  let workspacesService: WorkspacesService;
  let membersService: WorkspaceMembersService;

  let ownerUserId: string;
  let memberUserId: string;
  let workspaceId: string;
  let workspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;

  let ownerBookmarkA: string;
  let ownerBookmarkB: string;
  let memberBookmark: string;
  let folderId: string;
  let tagId: string;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const accountsService = moduleRef.get(AccountsService);
    bulkService = moduleRef.get(BulkBookmarksService);
    bookmarksService = moduleRef.get(BookmarksService);
    foldersService = moduleRef.get(FoldersService);
    tagsService = moduleRef.get(TagsService);
    workspacesService = moduleRef.get(WorkspacesService);
    membersService = moduleRef.get(WorkspaceMembersService);

    const owner = await accountsService.registerAccount({
      email: "bulk-owner@example.com",
      name: "Bulk Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const member = await accountsService.registerAccount({
      email: "bulk-member@example.com",
      name: "Bulk Member",
      password: "password-abc-123",
    });
    memberUserId = member.id;

    const ws = await workspacesService.createWorkspace(
      { name: "Bulk Workspace", slug: "bulk-ws" },
      ownerUserId,
    );
    workspaceId = ws.id;
    workspace = ws;

    await membersService.addMember(workspaceId, memberUserId, "MEMBER", ownerUserId);

    const folder = await foldersService.createFolder(workspace, ownerUserId, {
      name: "Bulk Folder",
    });
    folderId = folder.id;

    const tag = await tagsService.createTag(workspace, ownerUserId, {
      name: "bulk-tag",
    });
    tagId = tag.id;

    ownerBookmarkA = (
      await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Owner Alpha",
        url: "https://alpha.example.com",
      })
    ).id;

    ownerBookmarkB = (
      await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Owner Beta",
        url: "https://beta.example.com",
      })
    ).id;

    memberBookmark = (
      await bookmarksService.createBookmark(workspace, memberUserId, {
        title: "Member Only",
        url: "https://member.example.com",
      })
    ).id;
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  it("skips non-owned bookmarks when using explicit IDs", async () => {
    const result = await bulkService.bulkPin(workspace, ownerUserId, {
      bookmarkIds: [ownerBookmarkA, memberBookmark],
      pinned: true,
    });

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skippedIds).toEqual([memberBookmark]);

    const pinned = await bookmarksService.getBookmark(
      workspace,
      ownerUserId,
      ownerBookmarkA,
    );
    expect(pinned.pinned).toBe(true);

    const memberBm = await bookmarksService.getBookmark(
      workspace,
      memberUserId,
      memberBookmark,
    );
    expect(memberBm.pinned).toBe(false);
  });

  it("bulk unpins via explicit selection", async () => {
    const result = await bulkService.bulkPin(workspace, ownerUserId, {
      bookmarkIds: [ownerBookmarkA, ownerBookmarkB],
      pinned: false,
    });

    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);

    const a = await bookmarksService.getBookmark(workspace, ownerUserId, ownerBookmarkA);
    const b = await bookmarksService.getBookmark(workspace, ownerUserId, ownerBookmarkB);
    expect(a.pinned).toBe(false);
    expect(b.pinned).toBe(false);
  });

  it("bulk move-to-folder adds owned bookmarks to the folder", async () => {
    const result = await bulkService.bulkMoveToFolder(workspace, ownerUserId, {
      bookmarkIds: [ownerBookmarkA, ownerBookmarkB],
      folderId,
    });

    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);

    const aFolders = await foldersService.listFolderIdsForBookmark(
      workspaceId,
      ownerBookmarkA,
    );
    const bFolders = await foldersService.listFolderIdsForBookmark(
      workspaceId,
      ownerBookmarkB,
    );
    expect(aFolders).toContain(folderId);
    expect(bFolders).toContain(folderId);
  });

  it("bulk add-tags and preview merge counts", async () => {
    await tagsService.addBookmarkToTag(workspace, ownerUserId, tagId, ownerBookmarkA);

    const preview = await bulkService.previewBulkAddTags(workspace, ownerUserId, {
      bookmarkIds: [ownerBookmarkA, ownerBookmarkB],
      tagIds: [tagId],
    });
    expect(preview.total).toBe(2);
    expect(preview.tags[0]).toEqual({
      tagId,
      alreadyTagged: 1,
      newlyTagged: 1,
    });

    const result = await bulkService.bulkAddTags(workspace, ownerUserId, {
      bookmarkIds: [ownerBookmarkA, ownerBookmarkB],
      tagIds: [tagId],
    });
    expect(result.processed).toBe(2);

    const aTags = await tagsService.listTagIdsForBookmark(workspaceId, ownerBookmarkA);
    const bTags = await tagsService.listTagIdsForBookmark(workspaceId, ownerBookmarkB);
    expect(aTags).toContain(tagId);
    expect(bTags).toContain(tagId);
  });

  it("bulk remove-tags removes tag links from owned bookmarks", async () => {
    const result = await bulkService.bulkRemoveTags(workspace, ownerUserId, {
      bookmarkIds: [ownerBookmarkA, ownerBookmarkB],
      tagIds: [tagId],
    });

    expect(result.processed).toBe(2);

    const aTags = await tagsService.listTagIdsForBookmark(workspaceId, ownerBookmarkA);
    const bTags = await tagsService.listTagIdsForBookmark(workspaceId, ownerBookmarkB);
    expect(aTags).not.toContain(tagId);
    expect(bTags).not.toContain(tagId);
  });

  it("select-all mode applies list filters and skips member bookmarks", async () => {
    const pinnedId = (
      await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Select All Pinned",
        url: "https://pinned.example.com",
        pinned: true,
      })
    ).id;

    await bookmarksService.createBookmark(workspace, ownerUserId, {
      title: "Select All Unpinned",
      url: "https://unpinned.example.com",
      pinned: false,
    });

    const result = await bulkService.bulkDelete(workspace, ownerUserId, {
      selectAll: true,
      pinned: true,
    });

    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBe(0);
    expect(result.skippedIds).not.toContain(memberBookmark);

    await expect(
      bookmarksService.getBookmark(workspace, ownerUserId, pinnedId),
    ).rejects.toThrow("Bookmark not found");

    const memberStill = await bookmarksService.getBookmark(
      workspace,
      memberUserId,
      memberBookmark,
    );
    expect(memberStill.id).toBe(memberBookmark);
  });

  it("bulk delete removes owned bookmarks by explicit IDs", async () => {
    const temp = await bookmarksService.createBookmark(workspace, ownerUserId, {
      title: "Temp Delete",
      url: "https://temp-delete.example.com",
    });

    const result = await bulkService.bulkDelete(workspace, ownerUserId, {
      bookmarkIds: [temp.id, memberBookmark],
    });

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skippedIds).toEqual([memberBookmark]);

    await expect(
      bookmarksService.getBookmark(workspace, ownerUserId, temp.id),
    ).rejects.toThrow("Bookmark not found");
  });
});
