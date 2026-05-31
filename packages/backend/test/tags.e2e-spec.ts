import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import { TagsService } from "../src/tags/tags.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Tags (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let tagsService: TagsService;
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
    tagsService = moduleRef.get(TagsService);
    bookmarksService = moduleRef.get(BookmarksService);
    workspacesService = moduleRef.get(WorkspacesService);
    membersService = moduleRef.get(WorkspaceMembersService);

    const owner = await accountsService.registerAccount({
      email: "tag-owner@example.com",
      name: "Tag Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const member = await accountsService.registerAccount({
      email: "tag-member@example.com",
      name: "Tag Member",
      password: "password-abc-123",
    });
    memberUserId = member.id;

    const ws = await workspacesService.createWorkspace(
      { name: "Tag Workspace", slug: "tag-ws" },
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

  describe("CRUD + user privacy", () => {
    let tagId: string;

    it("creates a tag with optional color", async () => {
      const tag = await tagsService.createTag(workspace, ownerUserId, {
        name: "research",
        color: "#7782f7",
      });

      expect(tag.id).toBeTruthy();
      expect(tag.workspaceId).toBe(workspaceId);
      expect(tag.userId).toBe(ownerUserId);
      expect(tag.name).toBe("research");
      expect(tag.color).toBe("#7782f7");
      expect(tag.bookmarkCount).toBe(0);
      tagId = tag.id;
    });

    it("reads the tag for the owner", async () => {
      const tag = await tagsService.getTag(workspace, ownerUserId, tagId);
      expect(tag.id).toBe(tagId);
    });

    it("rejects read by another workspace member", async () => {
      await expect(
        tagsService.getTag(workspace, memberUserId, tagId),
      ).rejects.toThrow("Tag is not accessible");
    });

    it("lists tags scoped to the requesting user only", async () => {
      await tagsService.createTag(workspace, ownerUserId, { name: "inbox" });
      await tagsService.createTag(workspace, memberUserId, { name: "member-only" });

      const ownerPage = await tagsService.listTags(workspace, ownerUserId, {
        q: "research",
        sort: "name-asc",
        page: 1,
        pageSize: 10,
      });

      expect(ownerPage.total).toBeGreaterThanOrEqual(1);
      expect(ownerPage.items.some((t) => t.name === "research")).toBe(true);
      expect(ownerPage.items.every((t) => t.userId === ownerUserId)).toBe(true);
      expect(ownerPage.items.some((t) => t.name === "member-only")).toBe(false);

      const memberPage = await tagsService.listTags(workspace, memberUserId, {
        page: 1,
        pageSize: 50,
      });
      expect(memberPage.items.every((t) => t.userId === memberUserId)).toBe(true);
      expect(memberPage.items.some((t) => t.name === "research")).toBe(false);
    });

    it("updates tag fields", async () => {
      const updated = await tagsService.updateTag(workspace, ownerUserId, tagId, {
        name: "Research",
        color: "#45c98a",
      });
      expect(updated.name).toBe("Research");
      expect(updated.color).toBe("#45c98a");
    });

    it("rejects update by another workspace member", async () => {
      await expect(
        tagsService.updateTag(workspace, memberUserId, tagId, {
          name: "Hijacked",
        }),
      ).rejects.toThrow("Tag is not accessible");
    });

    it("deletes the tag", async () => {
      await tagsService.deleteTag(workspace, ownerUserId, tagId);
      await expect(
        tagsService.getTag(workspace, ownerUserId, tagId),
      ).rejects.toThrow("Tag not found");
    });
  });

  describe("bookmark many-to-many", () => {
    it("allows a bookmark to have multiple tags", async () => {
      const bookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Multi-tag bookmark",
        url: "https://multi-tag.example.com",
      });

      const tagA = await tagsService.createTag(workspace, ownerUserId, {
        name: "Tag A",
      });
      const tagB = await tagsService.createTag(workspace, ownerUserId, {
        name: "Tag B",
      });

      await tagsService.addBookmarkToTag(
        workspace,
        ownerUserId,
        tagA.id,
        bookmark.id,
      );
      await tagsService.addBookmarkToTag(
        workspace,
        ownerUserId,
        tagB.id,
        bookmark.id,
      );

      expect(await tagsService.countTagsForBookmark(workspaceId, bookmark.id)).toBe(
        2,
      );

      const tagIds = await tagsService.listTagIdsForBookmark(
        workspaceId,
        bookmark.id,
      );
      expect(tagIds.sort()).toEqual([tagA.id, tagB.id].sort());

      const refreshedA = await tagsService.getTag(workspace, ownerUserId, tagA.id);
      const refreshedB = await tagsService.getTag(workspace, ownerUserId, tagB.id);
      expect(refreshedA.bookmarkCount).toBe(1);
      expect(refreshedB.bookmarkCount).toBe(1);
    });

    it("sorts tags by usage for distribution overview", async () => {
      const bookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Popular tag bookmark",
        url: "https://popular.example.com",
      });

      const popular = await tagsService.createTag(workspace, ownerUserId, {
        name: "popular-tag",
        bookmarkIds: [bookmark.id],
      });
      await tagsService.createTag(workspace, ownerUserId, { name: "unused-tag" });

      const page = await tagsService.listTags(workspace, ownerUserId, {
        sort: "usage-desc",
        page: 1,
        pageSize: 50,
      });

      const popularIndex = page.items.findIndex((t) => t.id === popular.id);
      const unusedIndex = page.items.findIndex((t) => t.name === "unused-tag");
      expect(popularIndex).toBeGreaterThanOrEqual(0);
      expect(unusedIndex).toBeGreaterThanOrEqual(0);
      expect(popularIndex).toBeLessThan(unusedIndex);
    });

    it("removes bookmark-tag links when the bookmark is deleted", async () => {
      const bookmark = await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: "Cascade tag links",
        url: "https://cascade-tags.example.com",
      });
      const tag = await tagsService.createTag(workspace, ownerUserId, {
        name: "Cascade Tag",
        bookmarkIds: [bookmark.id],
      });

      expect(await tagsService.countTagsForBookmark(workspaceId, bookmark.id)).toBe(
        1,
      );

      await bookmarksService.deleteBookmark(workspace, ownerUserId, bookmark.id);

      expect(await tagsService.countTagsForBookmark(workspaceId, bookmark.id)).toBe(
        0,
      );

      const afterDelete = await tagsService.getTag(workspace, ownerUserId, tag.id);
      expect(afterDelete.bookmarkCount).toBe(0);
    });
  });
});
