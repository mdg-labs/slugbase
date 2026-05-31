import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import { FoldersService } from "../src/folders/folders.service.js";
import {
  DEFAULT_SEARCH_LIMIT_PER_TYPE,
  GLOBAL_SEARCH_FALLBACK,
  MAX_SEARCH_LIMIT_PER_TYPE,
} from "../src/search/search.constants.js";
import { SearchService } from "../src/search/search.service.js";
import { TagsService } from "../src/tags/tags.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Search (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let searchService: SearchService;
  let bookmarksService: BookmarksService;
  let foldersService: FoldersService;
  let tagsService: TagsService;
  let workspacesService: WorkspacesService;

  let ownerUserId: string;
  let workspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    await runMigrations(testDatabase.databaseUrl);
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });
    delete process.env.SERVE_WEB_CLIENT;
    delete process.env.WEB_CLIENT_SERVER_BUILD;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const accountsService = moduleRef.get(AccountsService);
    searchService = moduleRef.get(SearchService);
    bookmarksService = moduleRef.get(BookmarksService);
    foldersService = moduleRef.get(FoldersService);
    tagsService = moduleRef.get(TagsService);
    workspacesService = moduleRef.get(WorkspacesService);

    const owner = await accountsService.registerAccount({
      email: "search-owner@example.com",
      name: "Search Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const ws = await workspacesService.createWorkspace(
      { name: "Search Workspace", slug: "search-ws" },
      ownerUserId,
    );
    workspace = ws;
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  it("searches bookmarks, folders, and tags in one response", async () => {
    await bookmarksService.createBookmark(workspace, ownerUserId, {
      title: "React Docs",
      url: "https://react.dev",
    });
    await foldersService.createFolder(workspace, ownerUserId, {
      name: "React Resources",
    });
    await tagsService.createTag(workspace, ownerUserId, {
      name: "react",
    });

    const result = await searchService.search(workspace, ownerUserId, {
      q: "react",
    });

    expect(result.q).toBe("react");
    expect(result.limits).toEqual({
      bookmarks: DEFAULT_SEARCH_LIMIT_PER_TYPE,
      folders: DEFAULT_SEARCH_LIMIT_PER_TYPE,
      tags: DEFAULT_SEARCH_LIMIT_PER_TYPE,
    });
    expect(result.bookmarks.items.some((b) => b.title === "React Docs")).toBe(
      true,
    );
    expect(
      result.folders.items.some((f) => f.name === "React Resources"),
    ).toBe(true);
    expect(result.tags.items.some((t) => t.name === "react")).toBe(true);
    expect(result.fallback).toEqual(GLOBAL_SEARCH_FALLBACK);
  });

  it("applies per-type limits and reports truncation", async () => {
    for (let i = 0; i < 5; i++) {
      await bookmarksService.createBookmark(workspace, ownerUserId, {
        title: `Alpha Bookmark ${String(i)}`,
        url: `https://alpha.example/${String(i)}`,
      });
    }

    const result = await searchService.search(workspace, ownerUserId, {
      q: "alpha",
      bookmarkLimit: 2,
      folderLimit: 1,
      tagLimit: MAX_SEARCH_LIMIT_PER_TYPE + 10,
    });

    expect(result.limits.bookmarks).toBe(2);
    expect(result.limits.folders).toBe(1);
    expect(result.limits.tags).toBe(MAX_SEARCH_LIMIT_PER_TYPE);
    expect(result.bookmarks.items).toHaveLength(2);
    expect(result.bookmarks.total).toBeGreaterThanOrEqual(5);
    expect(result.bookmarks.truncated).toBe(true);
    expect(result.folders.truncated).toBe(false);
    expect(result.tags.truncated).toBe(false);
  });

  it("rejects an empty query", async () => {
    await expect(
      searchService.search(workspace, ownerUserId, { q: "   " }),
    ).rejects.toThrow("q is required");
  });
});
