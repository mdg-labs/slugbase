import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import type { ExportBookmarkEntry } from "../src/export/export.types.js";
import { ExportService } from "../src/export/export.service.js";
import { FoldersService } from "../src/folders/folders.service.js";
import { ImportService } from "../src/import/import.service.js";
import { TagsService } from "../src/tags/tags.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

type NormalizedBookmark = {
  title: string;
  url: string;
  slug: string | null;
  forwardingEnabled: boolean;
  pinned: boolean;
  folders: string[];
  tags: string[];
};

async function normalizeWorkspaceBookmarks(
  bookmarksService: BookmarksService,
  foldersService: FoldersService,
  tagsService: TagsService,
  workspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>,
  userId: string,
): Promise<NormalizedBookmark[]> {
  const list = await bookmarksService.listBookmarks(workspace, userId, {
    scope: "mine",
    sort: "title-asc",
    pageSize: 100,
  });

  const normalized: NormalizedBookmark[] = [];

  for (const bookmark of list.items) {
    const folderIds = await foldersService.listFolderIdsForBookmark(
      workspace.id,
      bookmark.id,
    );
    const tagIds = await tagsService.listTagIdsForBookmark(workspace.id, bookmark.id);

    const folders: string[] = [];
    for (const folderId of folderIds) {
      const folder = await foldersService.getFolder(workspace, userId, folderId);
      folders.push(folder.name);
    }

    const tags: string[] = [];
    for (const tagId of tagIds) {
      const tag = await tagsService.getTag(workspace, userId, tagId);
      tags.push(tag.name);
    }

    normalized.push({
      title: bookmark.title,
      url: bookmark.url,
      slug: bookmark.slug,
      forwardingEnabled: bookmark.forwardingEnabled,
      pinned: bookmark.pinned,
      folders: folders.sort((a, b) => a.localeCompare(b)),
      tags: tags.sort((a, b) => a.localeCompare(b)),
    });
  }

  return normalized.sort((a, b) => a.title.localeCompare(b.title));
}

function exportEntriesToNormalized(entries: ExportBookmarkEntry[]): NormalizedBookmark[] {
  return entries
    .map((entry) => ({
      title: entry.title,
      url: entry.url,
      slug: entry.slug,
      forwardingEnabled: entry.forwardingEnabled,
      pinned: entry.pinned,
      folders: [...entry.folders].sort((a, b) => a.localeCompare(b)),
      tags: [...entry.tags].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

describe("Export (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let exportService: ExportService;
  let importService: ImportService;
  let bookmarksService: BookmarksService;
  let foldersService: FoldersService;
  let tagsService: TagsService;
  let workspacesService: WorkspacesService;
  let accountsService: AccountsService;

  let ownerUserId: string;
  let sourceWorkspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    accountsService = moduleRef.get(AccountsService);
    exportService = moduleRef.get(ExportService);
    importService = moduleRef.get(ImportService);
    bookmarksService = moduleRef.get(BookmarksService);
    foldersService = moduleRef.get(FoldersService);
    tagsService = moduleRef.get(TagsService);
    workspacesService = moduleRef.get(WorkspacesService);

    const owner = await accountsService.registerAccount({
      email: "export-owner@example.com",
      name: "Export Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    sourceWorkspace = await workspacesService.createWorkspace(
      { name: "Export Source", slug: "export-source", plan: "personal" },
      ownerUserId,
    );
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  describe("JSON export", () => {
    it("exports each accessible bookmark with full round-trip fields", async () => {
      const reading = await foldersService.createFolder(sourceWorkspace, ownerUserId, {
        name: "Reading",
      });
      const research = await tagsService.createTag(sourceWorkspace, ownerUserId, {
        name: "research",
      });

      const bookmark = await bookmarksService.createBookmark(
        sourceWorkspace,
        ownerUserId,
        {
          title: "Export Me",
          url: "https://export.example.com/page",
          slug: "export-me",
          forwardingEnabled: true,
          pinned: true,
        },
      );

      await foldersService.addBookmarkToFolder(
        sourceWorkspace,
        ownerUserId,
        reading.id,
        bookmark.id,
      );
      await tagsService.addBookmarkToTag(
        sourceWorkspace,
        ownerUserId,
        research.id,
        bookmark.id,
      );

      const exported = await exportService.exportJson(sourceWorkspace, ownerUserId);
      const entry = exported.find((item) => item.title === "Export Me");

      expect(entry).toEqual({
        title: "Export Me",
        url: "https://export.example.com/page",
        slug: "export-me",
        forwardingEnabled: true,
        pinned: true,
        folders: ["Reading"],
        tags: ["research"],
      });
    });

    it("export then import into a fresh workspace reproduces bookmarks, folders, and tags", async () => {
      const seedWorkspace = await workspacesService.createWorkspace(
        { name: "Round Trip Seed", slug: "round-trip-seed", plan: "personal" },
        ownerUserId,
      );

      await importService.importJson(seedWorkspace, ownerUserId, [
        {
          title: "Alpha",
          url: "https://roundtrip.example.com/a",
          slug: "alpha",
          forwardingEnabled: true,
          pinned: true,
          folders: ["Work", "Reading"],
          tags: ["docs", "priority"],
        },
        {
          title: "Beta",
          url: "https://roundtrip.example.com/b",
          slug: "beta",
          forwardingEnabled: false,
          pinned: false,
          folders: ["Work"],
          tags: ["docs"],
        },
        {
          title: "Gamma",
          url: "https://roundtrip.example.com/c",
          folders: ["Archive"],
          tags: ["later"],
        },
      ]);

      const exported = await exportService.exportJson(seedWorkspace, ownerUserId);
      expect(exported).toHaveLength(3);

      const targetWorkspace = await workspacesService.createWorkspace(
        { name: "Round Trip Target", slug: "round-trip-target", plan: "personal" },
        ownerUserId,
      );

      const importResult = await importService.importJson(
        targetWorkspace,
        ownerUserId,
        exported,
      );

      expect(importResult).toEqual({
        total: 3,
        successCount: 3,
        failureCount: 0,
        skippedSlugCount: 0,
        capLimitedCount: 0,
      });

      const sourceNormalized = exportEntriesToNormalized(exported);
      const targetNormalized = await normalizeWorkspaceBookmarks(
        bookmarksService,
        foldersService,
        tagsService,
        targetWorkspace,
        ownerUserId,
      );

      expect(targetNormalized).toEqual(sourceNormalized);

      const folderList = await foldersService.listFolders(targetWorkspace, ownerUserId, {
        pageSize: 100,
      });
      expect(folderList.items.map((f) => f.name).sort()).toEqual([
        "Archive",
        "Reading",
        "Work",
      ]);

      const tagList = await tagsService.listTags(targetWorkspace, ownerUserId, {
        pageSize: 100,
      });
      expect(tagList.items.map((t) => t.name).sort()).toEqual([
        "docs",
        "later",
        "priority",
      ]);
    });
  });
});
