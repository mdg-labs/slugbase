import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import {
  PERF_BOOKMARK_COUNT,
  PERF_EXTRA_WORKSPACES,
  PerfSeedError,
  assertHarnessDatabase,
  buildLargeInstance,
  largeSeedScript,
  perfServer,
  seedLargeInstance,
  type LargeInstance,
} from "../src/seed/index.ts";

const digest = (instance: LargeInstance): string => createHash("sha256").update(JSON.stringify(instance)).digest("hex");

describe("the large instance", () => {
  const instance = buildLargeInstance();
  const [large, ...others] = instance.workspaces;
  if (large === undefined) {
    throw new Error("the large instance has a large workspace");
  }

  it("has 50 000 bookmarks in one workspace and 2 000 further workspaces", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    expect(large.bookmarks).toHaveLength(PERF_BOOKMARK_COUNT);
    expect(PERF_BOOKMARK_COUNT).toBe(50_000);
    expect(others).toHaveLength(PERF_EXTRA_WORKSPACES);
    expect(PERF_EXTRA_WORKSPACES).toBe(2_000);
    expect(new Set(instance.workspaces.map((workspace) => workspace.id)).size).toBe(2_001);
    expect(new Set(instance.accounts.map((account) => account.email)).size).toBe(instance.accounts.length);
  });

  it("is the same on every run and differs with the seed", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    expect(digest(buildLargeInstance())).toBe(digest(instance));
    expect(digest(buildLargeInstance({ seed: 1 }))).not.toBe(digest(instance));
  });

  it("gives a realistic share of the rows a slug and others tags and folders", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const slugged = large.bookmarks.filter((bookmark) => bookmark.slug !== null);
    expect(slugged.length / large.bookmarks.length).toBeGreaterThan(0.08);
    expect(slugged.length / large.bookmarks.length).toBeLessThan(0.16);
    expect(large.bookmarks.every((bookmark) => bookmark.slug !== null || !bookmark.forwarding)).toBe(true);
    expect(large.bookmarks.some((bookmark) => bookmark.forwarding)).toBe(true);
    expect(new Set(large.bookmarks.map((bookmark) => bookmark.slug).filter((slug) => slug !== null)).size).toBeLessThan(slugged.length);
    for (const bookmark of slugged) {
      expect(bookmark.slug).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    }
    const perOwner = slugged.map((bookmark) => `${bookmark.ownerId}/${bookmark.slug ?? ""}`);
    expect(new Set(perOwner).size).toBe(perOwner.length);
    expect(new Set(large.bookmarkTags.map((link) => link.bookmarkId)).size / large.bookmarks.length).toBeGreaterThan(0.3);
    expect(new Set(large.folderBookmarks.map((link) => link.bookmarkId)).size / large.bookmarks.length).toBeGreaterThan(0.25);
    expect(large.tags.length).toBeGreaterThan(30);
    expect(large.folders.length).toBeGreaterThan(12);
    expect(others.every((workspace) => workspace.bookmarks.length === 10 && workspace.tags.length > 0 && workspace.folders.length > 0)).toBe(true);
  });

  it("keeps tags and folders with their owner and in their workspace", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    for (const workspace of instance.workspaces.slice(0, 50)) {
      const owners = new Map(workspace.bookmarks.map((bookmark) => [bookmark.id, bookmark.ownerId]));
      const tags = new Map(workspace.tags.map((tag) => [tag.id, tag.ownerId]));
      const folders = new Map(workspace.folders.map((folder) => [folder.id, folder.ownerId]));
      for (const link of workspace.bookmarkTags) {
        expect(tags.get(link.tagId)).toBe(owners.get(link.bookmarkId));
      }
      for (const link of workspace.folderBookmarks) {
        expect(folders.get(link.folderId)).toBe(owners.get(link.bookmarkId));
      }
      expect(new Set(workspace.bookmarkTags.map((link) => `${link.bookmarkId}/${link.tagId}`)).size).toBe(workspace.bookmarkTags.length);
    }
  });

  it("names, for the scenarios, slugs the first account resolves in the large workspace", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const admin = instance.accounts.find((account) => account.email === instance.fixtures.email);
    expect(admin?.isInstanceAdmin).toBe(true);
    const mine = new Set(large.bookmarks.filter((bookmark) => bookmark.ownerId === admin?.id && bookmark.forwarding).map((bookmark) => bookmark.slug));
    expect(instance.fixtures.slugs.length).toBeGreaterThan(100);
    expect(instance.fixtures.slugs.every((slug) => mine.has(slug))).toBe(true);
    expect(instance.fixtures.tagIds.length).toBeGreaterThan(0);
    expect(instance.fixtures.folderIds.length).toBeGreaterThan(0);
  });

  it("is written as one transaction that creates every account and workspace", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const script = largeSeedScript(buildLargeInstance({ bookmarks: 40, workspaces: 3 }), "$argon2id$stand-in");
    expect(script.startsWith("SET standard_conforming_strings = on;\nBEGIN;\nSET LOCAL ROLE slugbase_system;")).toBe(true);
    expect(script.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(script.match(/sys_create_account\(/gu)).toHaveLength(2 + 3 + 1);
    expect(script.match(/sys_create_workspace\(/gu)).toHaveLength(4);
  });
});

describe("the guard of the large instance", () => {
  // A handle that fails the test if the seed touches the database before it has refused.
  const untouchable = (name: string) => ({
    name,
    owner: new Proxy(
      {},
      {
        get(): never {
          throw new Error("the database was touched");
        },
        apply(): never {
          throw new Error("the database was touched");
        },
      },
    ) as never,
  });
  const server = { host: "127.0.0.1", port: 54329, path: "" };
  const instance = buildLargeInstance({ bookmarks: 20, workspaces: 1 });

  it.each(["slugbase_dev", "slugbase", "postgres", "template1", "slugbase_tpl_0123456789abcdef0123456789abcdef", "test_0123456789ABCDEF", "test_0123456789abcde", "test_0123456789abcdef0", "xtest_0123456789abcdef", "test_0123456789abcdef\n"])(
    "refuses the database %j before it touches it",
    async (name) => {
      expect(() => {
        assertHarnessDatabase(name);
      }).toThrow(PerfSeedError);
      await expect(seedLargeInstance(untouchable(name), server, instance, "$argon2id$stand-in")).rejects.toThrow(/test harness created/);
    },
  );

  it("accepts the name of a harness database", () => {
    expect(() => {
      assertHarnessDatabase("test_0123456789abcdef");
    }).not.toThrow();
  });

  it.each(["postgres://u:p@db.example.com:5432/postgres", "postgres://u:p@10.0.0.5/postgres", "postgres://u:p@127.0.0.1.example.com/postgres", "https://127.0.0.1/", "not a url"])(
    "refuses the server %j when the harness names no server",
    (url) => {
      expect(() => perfServer(url, "", "")).toThrow(PerfSeedError);
    },
  );

  it.each([
    ["postgres://u:p@db.example.com:5432/postgres", "postgres://u:p@postgres:5432/postgres"],
    ["postgres://u:p@postgres/postgres", "postgres://u:p@db.example.com/postgres"],
    ["postgres://u:p@10.0.0.5/postgres", "not a url"],
    ["postgres://u:p@db.example.com/postgres", "https://db.example.com/"],
    ["postgres://u:p@postgres.example.com/postgres", "postgres://u:p@postgres/postgres"],
  ])("refuses the server %j when the harness names another host, %j", (url, harness) => {
    expect(() => perfServer(url, "", harness)).toThrow(PerfSeedError);
  });

  it.each([
    ["postgres://u:p@127.0.0.1:54329/postgres", { host: "127.0.0.1", port: 54329 }],
    ["postgres://u:p@localhost/postgres", { host: "localhost", port: 5432 }],
    ["postgresql://u:p@[::1]:6543/postgres", { host: "::1", port: 6543 }],
  ])("accepts the local server %j", (url, expected) => {
    expect(perfServer(url, "/usr/bin", "")).toEqual({ ...expected, path: "/usr/bin" });
    expect(perfServer(url, "/usr/bin", "postgres://u:p@postgres/postgres")).toEqual({ ...expected, path: "/usr/bin" });
  });

  it.each([
    ["postgres://u:p@postgres:5432/postgres", "postgres://u:p@postgres:5432/postgres", { host: "postgres", port: 5432 }],
    ["postgresql://u:p@db.example.com/postgres", "postgres://x:y@DB.example.com:6000/other", { host: "db.example.com", port: 5432 }],
  ])("accepts the server %j that the harness is configured with, %j", (url, harness, expected) => {
    expect(perfServer(url, "/usr/bin", harness)).toEqual({ ...expected, path: "/usr/bin" });
  });
});
