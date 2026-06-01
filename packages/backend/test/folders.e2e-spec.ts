import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { FoldersService } from "../src/folders/folders.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Folders (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let foldersService: FoldersService;
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
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const accountsService = moduleRef.get(AccountsService);
    foldersService = moduleRef.get(FoldersService);
    bookmarksService = moduleRef.get(BookmarksService);
    workspacesService = moduleRef.get(WorkspacesService);
    membersService = moduleRef.get(WorkspaceMembersService);

    const owner = await accountsService.registerAccount({
      email: "folder-owner@example.com",
      name: "Folder Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const member = await accountsService.registerAccount({
      email: "folder-member@example.com",
      name: "Folder Member",
      password: "password-abc-123",
    });
    memberUserId = member.id;

    const ws = await workspacesService.createWorkspace(
      { name: "Folder Workspace", slug: "folder-ws" },
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
    let folderId: string;

    it("creates a folder with optional icon", async () => {
      const folder = await foldersService.createFolder(workspace, ownerUserId, {
        name: "Design Resources",
        icon: "palette",
      });

      expect(folder.id).toBeTruthy();
      expect(folder.workspaceId).toBe(workspaceId);
      expect(folder.userId).toBe(ownerUserId);
      expect(folder.name).toBe("Design Resources");
      expect(folder.icon).toBe("palette");
      expect(folder.bookmarkCount).toBe(0);
      folderId = folder.id;
    });

    it("reads the folder for the owner", async () => {
      const folder = await foldersService.getFolder(workspace, ownerUserId, folderId);
      expect(folder.id).toBe(folderId);
    });

    it("rejects read by a non-owner workspace member", async () => {
      await expect(
        foldersService.getFolder(workspace, memberUserId, folderId),
      ).rejects.toThrow("Folder is not accessible");
    });

    it("lists folders with search and pagination", async () => {
      await foldersService.createFolder(workspace, ownerUserId, {
        name: "Inbox",
      });

      const page = await foldersService.listFolders(workspace, ownerUserId, {
        q: "Design",
        sort: "name-asc",
        page: 1,
        pageSize: 10,
      });

      expect(page.total).toBeGreaterThanOrEqual(1);
      expect(page.items.some((f) => f.name === "Design Resources")).toBe(true);
      expect(page.items.every((f) => f.name.toLowerCase().includes("design"))).toBe(
        true,
      );
    });

    it("updates folder fields", async () => {
      const updated = await foldersService.updateFolder(
        workspace,
        ownerUserId,
        folderId,
        { name: "Design Kit", icon: "folder" },
      );
      expect(updated.name).toBe("Design Kit");
      expect(updated.icon).toBe("folder");
    });

    it("rejects update by a non-owner workspace member", async () => {
      await expect(
        foldersService.updateFolder(workspace, memberUserId, folderId, {
          name: "Hijacked",
        }),
      ).rejects.toThrow("Only the folder owner");
    });

    it("deletes the folder", async () => {
      await foldersService.deleteFolder(workspace, ownerUserId, folderId);
      await expect(
        foldersService.getFolder(workspace, ownerUserId, folderId),
      ).rejects.toThrow("Folder not found");
    });
  });

  describe("bookmark many-to-many", () => {
    it("allows a bookmark to belong to multiple folders", async () => {
      const bookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Multi-folder bookmark",
        url: "https://multi.example.com",
      });

      const folderA = await foldersService.createFolder(workspace, ownerUserId, {
        name: "Folder A",
      });
      const folderB = await foldersService.createFolder(workspace, ownerUserId, {
        name: "Folder B",
      });

      await foldersService.addBookmarkToFolder(
        workspace,
        ownerUserId,
        folderA.id,
        bookmark.id,
      );
      await foldersService.addBookmarkToFolder(
        workspace,
        ownerUserId,
        folderB.id,
        bookmark.id,
      );

      expect(
        await foldersService.countFoldersForBookmark(workspaceId, bookmark.id),
      ).toBe(2);

      const folderIds = await foldersService.listFolderIdsForBookmark(
        workspaceId,
        bookmark.id,
      );
      expect(folderIds.sort()).toEqual([folderA.id, folderB.id].sort());

      const refreshedA = await foldersService.getFolder(
        workspace,
        ownerUserId,
        folderA.id,
      );
      const refreshedB = await foldersService.getFolder(
        workspace,
        ownerUserId,
        folderB.id,
      );
      expect(refreshedA.bookmarkCount).toBe(1);
      expect(refreshedB.bookmarkCount).toBe(1);
    });

    it("removes bookmark-folder links when the bookmark is deleted", async () => {
      const bookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Cascade folder links",
        url: "https://cascade-folders.example.com",
      });
      const folder = await foldersService.createFolder(workspace, ownerUserId, {
        name: "Cascade Folder",
        bookmarkIds: [bookmark.id],
      });

      expect(
        await foldersService.countFoldersForBookmark(workspaceId, bookmark.id),
      ).toBe(1);

      await bookmarksService.deleteBookmark(workspace, ownerUserId, bookmark.id);

      expect(
        await foldersService.countFoldersForBookmark(workspaceId, bookmark.id),
      ).toBe(0);

      const afterDelete = await foldersService.getFolder(
        workspace,
        ownerUserId,
        folder.id,
      );
      expect(afterDelete.bookmarkCount).toBe(0);
    });
  });
});
