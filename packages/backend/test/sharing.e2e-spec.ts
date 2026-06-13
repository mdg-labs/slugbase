import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { FoldersService } from "../src/folders/folders.service.js";
import { GoService } from "../src/slugs/go.service.js";
import { SharingService } from "../src/sharing/sharing.service.js";
import { TeamsService } from "../src/teams/teams.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Sharing + authorization (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let bookmarksService: BookmarksService;
  let foldersService: FoldersService;
  let sharingService: SharingService;
  let goService: GoService;
  let teamsService: TeamsService;
  let workspacesService: WorkspacesService;
  let membersService: WorkspaceMembersService;

  let ownerUserId: string;
  let recipientUserId: string;
  let outsiderUserId: string;
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
    bookmarksService = moduleRef.get(BookmarksService);
    foldersService = moduleRef.get(FoldersService);
    sharingService = moduleRef.get(SharingService);
    goService = moduleRef.get(GoService);
    teamsService = moduleRef.get(TeamsService);
    workspacesService = moduleRef.get(WorkspacesService);
    membersService = moduleRef.get(WorkspaceMembersService);

    const owner = await accountsService.registerAccount({
      email: "share-owner@example.com",
      name: "Share Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const recipient = await accountsService.registerAccount({
      email: "share-recipient@example.com",
      name: "Share Recipient",
      password: "password-abc-123",
    });
    recipientUserId = recipient.id;

    const outsider = await accountsService.registerAccount({
      email: "share-outsider@example.com",
      name: "Share Outsider",
      password: "password-abc-123",
    });
    outsiderUserId = outsider.id;

    const ws = await workspacesService.createWorkspace(
      { name: "Sharing Workspace", slug: "sharing-ws" },
      ownerUserId,
    );
    workspaceId = ws.id;
    workspace = ws;

    await membersService.addMember(workspaceId, recipientUserId, "MEMBER", ownerUserId);
    await membersService.addMember(workspaceId, outsiderUserId, "MEMBER", ownerUserId);
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  describe("bookmark user share", () => {
    let bookmarkId: string;

    beforeAll(async () => {
      const bookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Shared Bookmark",
        url: "https://shared.example.com",
        slug: "shared-bm",
        forwardingEnabled: true,
      });
      bookmarkId = bookmark.id;

      await sharingService.shareBookmarkWithUser(
        workspace,
        ownerUserId,
        bookmarkId,
        recipientUserId,
      );
    });

    it("allows recipient read access", async () => {
      const bookmark = await bookmarksService.getBookmark(
        workspace,
        recipientUserId,
        bookmarkId,
      );
      expect(bookmark.id).toBe(bookmarkId);
    });

    it("denies non-recipient read access", async () => {
      await expect(
        bookmarksService.getBookmark(workspace, outsiderUserId, bookmarkId),
      ).rejects.toThrow("Bookmark is not accessible");
    });

    it("includes shared bookmark in recipient list (scope=all)", async () => {
      const result = await bookmarksService.listBookmarks(workspace, recipientUserId, {
        scope: "all",
      });
      expect(result.items.some((b) => b.id === bookmarkId)).toBe(true);
    });

    it("includes shared bookmark in shared-with-me scope", async () => {
      const result = await bookmarksService.listBookmarks(workspace, recipientUserId, {
        scope: "shared-with-me",
      });
      expect(result.items.some((b) => b.id === bookmarkId)).toBe(true);
    });

    it("denies recipient update", async () => {
      await expect(
        bookmarksService.updateBookmark(workspace, recipientUserId, bookmarkId, {
          title: "Hijacked",
        }),
      ).rejects.toThrow("Only the bookmark owner may modify this bookmark");
    });

    it("honors sharing in /go redirect", async () => {
      const result = await goService.resolveSlug(workspace, recipientUserId, "shared-bm");
      expect(result.kind).toBe("redirect");
      if (result.kind === "redirect") {
        expect(result.url).toBe("https://shared.example.com");
      }
    });
  });

  describe("folder share transitivity", () => {
    let folderId: string;
    let bookmarkId: string;

    beforeAll(async () => {
      const bookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Folder Child",
        url: "https://folder-child.example.com",
        slug: "folder-child",
        forwardingEnabled: true,
      });
      bookmarkId = bookmark.id;

      const folder = await foldersService.createFolder(workspace, ownerUserId, {
        name: "Shared Folder",
        bookmarkIds: [bookmarkId],
      });
      folderId = folder.id;

      await sharingService.shareFolderWithUser(
        workspace,
        ownerUserId,
        folderId,
        recipientUserId,
      );
    });

    it("allows recipient to read shared folder", async () => {
      const folder = await foldersService.getFolder(workspace, recipientUserId, folderId);
      expect(folder.id).toBe(folderId);
    });

    it("transitively exposes contained bookmark to recipient", async () => {
      const bookmark = await bookmarksService.getBookmark(
        workspace,
        recipientUserId,
        bookmarkId,
      );
      expect(bookmark.id).toBe(bookmarkId);
    });

    it("honors folder-share transitivity in /go", async () => {
      const result = await goService.resolveSlug(workspace, recipientUserId, "folder-child");
      expect(result.kind).toBe("redirect");
      if (result.kind === "redirect") {
        expect(result.url).toBe("https://folder-child.example.com");
      }
    });

    it("denies outsider access to folder-shared bookmark", async () => {
      await expect(
        bookmarksService.getBookmark(workspace, outsiderUserId, bookmarkId),
      ).rejects.toThrow("Bookmark is not accessible");
    });
  });

  describe("team bookmark share", () => {
    let teamBookmarkId: string;

    beforeAll(async () => {
      const team = await teamsService.createTeam(workspace, ownerUserId, {
        name: "Share Team",
        memberIds: [ownerUserId, recipientUserId],
      });

      const bookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Team Shared",
        url: "https://team-shared.example.com",
        slug: "team-shared",
        forwardingEnabled: true,
      });
      teamBookmarkId = bookmark.id;

      await sharingService.shareBookmarkWithTeam(
        workspace,
        ownerUserId,
        teamBookmarkId,
        team.id,
      );
    });

    it("allows team member read access", async () => {
      const bookmark = await bookmarksService.getBookmark(
        workspace,
        recipientUserId,
        teamBookmarkId,
      );
      expect(bookmark.id).toBe(teamBookmarkId);
    });

    it("denies non-team member read access", async () => {
      await expect(
        bookmarksService.getBookmark(workspace, outsiderUserId, teamBookmarkId),
      ).rejects.toThrow("Bookmark is not accessible");
    });
  });

  describe("slug preference auto-prune on share revoke", () => {
    it("removes recipient preference when revoke leaves one accessible match", async () => {
      const ownerBookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Owner Collision",
        url: "https://owner-collision.example.com",
        slug: "share-collision",
        forwardingEnabled: true,
      });
      await bookmarksService.createBookmark(workspace, recipientUserId, {
        title: "Recipient Collision",
        url: "https://recipient-collision.example.com",
        slug: "share-collision",
        forwardingEnabled: true,
      });

      await sharingService.shareBookmarkWithUser(
        workspace,
        ownerUserId,
        ownerBookmark.id,
        recipientUserId,
      );

      const recipientOwn = await bookmarksService.listBookmarks(workspace, recipientUserId, {
        scope: "mine",
      });
      const recipientBookmark = recipientOwn.items.find(
        (item) => item.slug === "share-collision",
      );
      expect(recipientBookmark).toBeTruthy();

      await goService.chooseSlugTarget(
        workspace,
        recipientUserId,
        "share-collision",
        ownerBookmark.id,
        true,
      );

      const prefsBefore = await goService.listPreferences(workspace, recipientUserId);
      expect(
        prefsBefore.some(
          (p) => p.slug === "share-collision" && p.bookmarkId === ownerBookmark.id,
        ),
      ).toBe(true);

      const grants = await sharingService.listBookmarkShares(
        workspace,
        ownerUserId,
        ownerBookmark.id,
      );
      const userGrant = grants.find((grant) => grant.kind === "user");
      expect(userGrant).toBeTruthy();
      if (!userGrant) return;

      await sharingService.revokeBookmarkShare(
        workspace,
        ownerUserId,
        ownerBookmark.id,
        userGrant.id,
      );

      const prefsAfter = await goService.listPreferences(workspace, recipientUserId);
      expect(prefsAfter.some((p) => p.slug === "share-collision")).toBe(false);

      const result = await goService.resolveSlug(
        workspace,
        recipientUserId,
        "share-collision",
      );
      expect(result.kind).toBe("redirect");
      if (result.kind === "redirect") {
        expect(result.url).toBe("https://recipient-collision.example.com");
      }
    });
  });
});
