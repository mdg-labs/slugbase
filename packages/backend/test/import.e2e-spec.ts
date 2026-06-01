import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { FREE_BOOKMARK_CAP } from "../src/entitlements/entitlements.service.js";
import { FoldersService } from "../src/folders/folders.service.js";
import { ImportService } from "../src/import/import.service.js";
import { TagsService } from "../src/tags/tags.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Import (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let importService: ImportService;
  let bookmarksService: BookmarksService;
  let foldersService: FoldersService;
  let tagsService: TagsService;
  let workspacesService: WorkspacesService;
  let accountsService: AccountsService;

  let ownerUserId: string;
  let workspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      STRIPE_SECRET_KEY: "sk_test_hosted_plan_gating",
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    accountsService = moduleRef.get(AccountsService);
    importService = moduleRef.get(ImportService);
    bookmarksService = moduleRef.get(BookmarksService);
    foldersService = moduleRef.get(FoldersService);
    tagsService = moduleRef.get(TagsService);
    workspacesService = moduleRef.get(WorkspacesService);

    const owner = await accountsService.registerAccount({
      email: "import-owner@example.com",
      name: "Import Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    workspace = await workspacesService.createWorkspace(
      { name: "Import Workspace", slug: "import-ws" },
      ownerUserId,
    );
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  describe("JSON import", () => {
    it("imports bookmarks with folders, tags, and valid slugs", async () => {
      const result = await importService.importJson(workspace, ownerUserId, [
        {
          title: "Imported Site",
          url: "https://import.example.com",
          slug: "imported",
          forwardingEnabled: true,
          pinned: true,
          folders: ["Reading"],
          tags: ["research"],
        },
        {
          title: "Second Site",
          url: "https://second.example.com",
          slug: "INVALID SLUG",
          folders: ["Reading"],
          tags: ["research", "new-tag"],
        },
      ]);

      expect(result).toEqual({
        total: 2,
        successCount: 2,
        failureCount: 0,
        skippedSlugCount: 1,
        capLimitedCount: 0,
      });

      const list = await bookmarksService.listBookmarks(workspace, ownerUserId, {
        sort: "title-asc",
      });
      const imported = list.items.find((b) => b.title === "Imported Site");
      const second = list.items.find((b) => b.title === "Second Site");

      expect(imported).toMatchObject({
        slug: "imported",
        forwardingEnabled: true,
        pinned: true,
        userId: ownerUserId,
        workspaceId: workspace.id,
      });
      expect(second?.slug).toBeNull();

      const folderList = await foldersService.listFolders(workspace, ownerUserId, {
        q: "Reading",
      });
      expect(folderList.items.some((f) => f.name === "Reading")).toBe(true);

      const tagList = await tagsService.listTags(workspace, ownerUserId, {});
      expect(tagList.items.some((t) => t.name === "research")).toBe(true);
      expect(tagList.items.some((t) => t.name === "new-tag")).toBe(true);

      if (imported) {
        expect(await foldersService.countFoldersForBookmark(workspace.id, imported.id)).toBe(
          1,
        );
        expect(await tagsService.countTagsForBookmark(workspace.id, imported.id)).toBe(1);
      }
    });

    it("skips duplicate slugs without failing the import", async () => {
      const result = await importService.importJson(workspace, ownerUserId, [
        {
          title: "Dup Slug One",
          url: "https://dup1.example.com",
          slug: "dup-slug",
        },
        {
          title: "Dup Slug Two",
          url: "https://dup2.example.com",
          slug: "dup-slug",
        },
      ]);

      expect(result.successCount).toBe(2);
      expect(result.skippedSlugCount).toBe(1);

      const list = await bookmarksService.listBookmarks(workspace, ownerUserId, {
        q: "Dup Slug",
      });
      const withSlug = list.items.filter((b) => b.slug === "dup-slug");
      expect(withSlug).toHaveLength(1);
    });
  });

  describe("Netscape HTML import", () => {
    it("imports bookmarks from browser export HTML", async () => {
      const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Browser</H3>
  <DL><p>
    <DT><A HREF="https://browser.example.com/a">Browser A</A>
  </DL><p>
</DL><p>`;

      const result = await importService.importNetscapeHtml(
        workspace,
        ownerUserId,
        html,
      );

      expect(result).toEqual({
        total: 1,
        successCount: 1,
        failureCount: 0,
        skippedSlugCount: 0,
        capLimitedCount: 0,
      });

      const list = await bookmarksService.listBookmarks(workspace, ownerUserId, {
        q: "Browser A",
      });
      expect(list.items[0]).toMatchObject({
        title: "Browser A",
        url: "https://browser.example.com/a",
        userId: ownerUserId,
      });

      const folderList = await foldersService.listFolders(workspace, ownerUserId, {
        q: "Browser",
      });
      expect(folderList.items.some((f) => f.name === "Browser")).toBe(true);
    });
  });

  describe("Free bookmark cap enforcement on import", () => {
    let capWorkspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;

    beforeAll(async () => {
      capWorkspace = await workspacesService.createWorkspace(
        { name: "Import Cap Workspace", slug: "import-cap-ws", plan: "free" },
        ownerUserId,
      );

      for (let i = 0; i < FREE_BOOKMARK_CAP - 2; i += 1) {
        await bookmarksService.createBookmark(capWorkspace, ownerUserId, {
          title: `Existing ${String(i + 1)}`,
          url: `https://existing.example.com/${String(i + 1)}`,
        });
      }
    });

    it("imports only until the Free cap is reached", async () => {
      const result = await importService.importJson(capWorkspace, ownerUserId, [
        { title: "Cap One", url: "https://cap.example.com/1" },
        { title: "Cap Two", url: "https://cap.example.com/2" },
        { title: "Cap Three", url: "https://cap.example.com/3" },
        { title: "Cap Four", url: "https://cap.example.com/4" },
      ]);

      expect(result).toEqual({
        total: 4,
        successCount: 2,
        failureCount: 2,
        skippedSlugCount: 0,
        capLimitedCount: 2,
      });

      const list = await bookmarksService.listBookmarks(capWorkspace, ownerUserId, {
        scope: "mine",
        pageSize: 100,
      });
      expect(list.total).toBe(FREE_BOOKMARK_CAP);
    });
  });
});
