import { readFileSync } from "node:fs";
import { verify } from "@node-rs/argon2";
import { normalizeBookmarkUrl } from "@slugbase/core";
import { describe, expect, it } from "vitest";
import {
  BOOKMARK_SHAPE_NAMES,
  DEMO_BOOKMARK_COUNT,
  DEVELOPMENT_DATABASE,
  LARGE_BOOKMARK_COUNT,
  SeedTargetError,
  bookmarkShapes,
  buildDemoInstance,
  createCredentials,
  createIds,
  createRandom,
  developmentTarget,
  seedScript,
  type SeedBookmark,
} from "../src/seed/index.ts";

const instance = buildDemoInstance();
const [demo, large] = instance.workspaces;
if (demo === undefined || large === undefined) {
  throw new Error("the demo instance has two workspaces");
}
const all = [...demo.bookmarks, ...large.bookmarks];

function shape(name: (typeof BOOKMARK_SHAPE_NAMES)[number]): SeedBookmark {
  const index = BOOKMARK_SHAPE_NAMES.indexOf(name);
  const bookmark = demo?.bookmarks[index];
  if (bookmark === undefined) {
    throw new Error(`no shape ${name}`);
  }
  return bookmark;
}

const codePoints = (text: string): number => Array.from(text).length;

describe("the demo instance", () => {
  it("has the sizes the seed promises", () => {
    expect(demo.bookmarks).toHaveLength(DEMO_BOOKMARK_COUNT);
    expect(large.bookmarks).toHaveLength(LARGE_BOOKMARK_COUNT);
    expect(DEMO_BOOKMARK_COUNT).toBe(300);
    expect(LARGE_BOOKMARK_COUNT).toBe(5_000);
  });

  it("is the same on every run and differs for another seed", () => {
    expect(buildDemoInstance()).toEqual(instance);
    expect(buildDemoInstance({ seed: 1 })).not.toEqual(instance);
  });

  it("gives every row an id shaped like a UUIDv7, unique across the instance", () => {
    const ids = [...instance.accounts.map((account) => account.id), ...instance.workspaces.map((workspace) => workspace.id), ...all.map((bookmark) => bookmark.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("stays within what the bookmarks table accepts", () => {
    for (const bookmark of all) {
      expect(codePoints(bookmark.title)).toBeGreaterThanOrEqual(1);
      expect(codePoints(bookmark.title)).toBeLessThanOrEqual(300);
      expect(codePoints(bookmark.description ?? "")).toBeLessThanOrEqual(1_000);
      expect(bookmark.url.length).toBeLessThanOrEqual(2_048);
      expect(bookmark.url).toMatch(/^https?:\/\//i);
      const normalised = normalizeBookmarkUrl(bookmark.url);
      expect(normalised.ok && normalised.value.url === bookmark.url && normalised.value.canonical === bookmark.urlCanonical).toBe(true);
      expect(bookmark.lastOpenedAt === null).toBe(bookmark.openCount === 0);
      if (bookmark.lastOpenedAt !== null) {
        expect(bookmark.lastOpenedAt.getTime()).toBeGreaterThanOrEqual(bookmark.createdAt.getTime());
      }
    }
  });

  it("owns every bookmark by a member of its workspace", () => {
    const members = new Map(
      instance.workspaces.map((workspace) => [workspace.id, new Set([instance.accounts.find((account) => account.key === workspace.owner)?.id, ...workspace.members.map((member) => instance.accounts.find((account) => account.key === member.account)?.id)])]),
    );
    for (const workspace of instance.workspaces) {
      for (const bookmark of workspace.bookmarks) {
        expect(members.get(workspace.id)?.has(bookmark.ownerId)).toBe(true);
      }
    }
  });
});

describe("the slugs of the demo workspace", () => {
  const admin = instance.accounts.find((account) => account.key === "admin")?.id;
  const member = instance.accounts.find((account) => account.key === "member")?.id;
  const slugsOf = (ownerId: string | undefined): string[] =>
    demo.bookmarks
      .filter((bookmark) => bookmark.ownerId === ownerId && bookmark.slug !== undefined && bookmark.slug !== null)
      .map((bookmark) => bookmark.slug ?? "")
      .sort();

  it("collide across the two members: both have docs, mail and wiki, and each slug is the owner's alone", () => {
    expect(slugsOf(admin)).toEqual(["docs", "mail", "standup", "wiki"]);
    expect(slugsOf(member)).toEqual(["docs", "mail", "wiki"]);
    expect(demo.bookmarks.filter((bookmark) => bookmark.slug !== undefined && bookmark.slug !== null).every((bookmark) => bookmark.forwarding === true)).toBe(true);
    expect(demo.bookmarks.filter((bookmark) => bookmark.slug === undefined || bookmark.slug === null).every((bookmark) => bookmark.forwarding !== true)).toBe(true);
  });

  it("are shared with the member: mail and standup in a folder of the admin's shared with them, and wiki directly", () => {
    const adminsBookmark = (slug: string): string | undefined => demo.bookmarks.find((bookmark) => bookmark.slug === slug && bookmark.ownerId === admin)?.id;
    expect(demo.folders).toEqual([
      { id: expect.any(String) as string, owner: "admin", name: "Team links", bookmarkIds: [adminsBookmark("mail"), adminsBookmark("standup")], shares: [{ id: expect.any(String) as string, target: "member" }] },
    ]);
    expect(demo.bookmarkShares).toEqual([{ id: expect.any(String) as string, bookmarkId: adminsBookmark("wiki"), granted: "admin", target: "member" }]);
  });

  it("add no bookmark and leave the rows they do not name as they were", () => {
    expect(demo.bookmarks).toHaveLength(DEMO_BOOKMARK_COUNT);
    expect(large.folders).toEqual([]);
    expect(large.bookmarkShares).toEqual([]);
    expect(large.bookmarks.every((bookmark) => bookmark.slug === undefined)).toBe(true);
  });

  it("are left out of a workspace too small to hold the filler", () => {
    const tiny = buildDemoInstance({ demoBookmarks: 5, largeBookmarks: 1 }).workspaces[0];
    expect(tiny?.bookmarks.every((bookmark) => bookmark.slug === undefined)).toBe(true);
    expect(tiny?.folders).toEqual([]);
    expect(tiny?.bookmarkShares).toEqual([]);
  });
});

describe("the shapes that break a UI", () => {
  it("start every workspace's list, in the order of BOOKMARK_SHAPE_NAMES", () => {
    const names = bookmarkShapes({ random: createRandom(1), ids: createIds(createRandom(2), 0), owners: ["owner"], now: new Date(0) }).map((entry) => entry.name);
    expect(names).toEqual([...BOOKMARK_SHAPE_NAMES]);
    const titles = (workspace: typeof demo): string[] => workspace.bookmarks.slice(0, names.length).map((bookmark) => bookmark.title);
    expect(titles(large)).toEqual(titles(demo));
    expect(titles(demo)[names.indexOf("markup-title")]).toBe("<img src=x onerror=alert(1)>");
  });

  it("includes titles and a description at the length limits", () => {
    expect(codePoints(shape("longest-title").title)).toBe(300);
    expect(codePoints(shape("longest-title").description ?? "")).toBe(1_000);
    expect(shape("longest-title").url.length).toBeGreaterThan(1_900);
    expect(shape("unbreakable-title").title).not.toMatch(/\s/);
    expect(codePoints(shape("single-character-title").title)).toBe(1);
  });

  it("includes right-to-left, mixed-direction and emoji titles", () => {
    expect(shape("rtl-arabic").title).toMatch(/\p{Script=Arabic}/u);
    expect(shape("rtl-hebrew").title).toMatch(/\p{Script=Hebrew}/u);
    expect(shape("mixed-direction").title).toMatch(/SlugBase.*\p{Script=Arabic}.*\p{Script=Hebrew}/u);
    expect(shape("emoji").title).toMatch(/\p{Extended_Pictographic}/u);
    expect(shape("emoji").title).toContain("‍");
    expect(shape("emoji-only").title).toMatch(/^\p{Extended_Pictographic}+$/u);
  });

  it("includes markup-like text in titles and descriptions", () => {
    expect(shape("markup-title").title).toBe("<img src=x onerror=alert(1)>");
    expect(shape("markup-title").description).toContain("<script>alert(1)</script>");
    expect(shape("markup-description").description).toContain("<img src=x onerror=alert(1)>");
    expect(shape("markup-entities").title).toContain("&lt;b&gt;");
  });

  it("includes pinned rows, rows with opens and rows without", () => {
    expect(shape("pinned-opened").pinnedAt).not.toBeNull();
    expect(shape("pinned-opened").openCount).toBeGreaterThan(0);
    expect(shape("pinned-unopened").pinnedAt).not.toBeNull();
    expect(shape("pinned-unopened").openCount).toBe(0);
    expect(shape("opened-often").openCount).toBe(1_234_567);
    expect(shape("never-opened")).toMatchObject({ openCount: 0, lastOpenedAt: null, pinnedAt: null });
    for (const workspace of [demo, large]) {
      expect(workspace.bookmarks.filter((bookmark) => bookmark.pinnedAt !== null).length).toBeGreaterThan(BOOKMARK_SHAPE_NAMES.filter((name) => name.startsWith("pinned")).length);
      expect(workspace.bookmarks.filter((bookmark) => bookmark.openCount > 0).length).toBeGreaterThan(workspace.bookmarks.length / 3);
      expect(workspace.bookmarks.filter((bookmark) => bookmark.openCount === 0).length).toBeGreaterThan(workspace.bookmarks.length / 3);
    }
  });

  it("includes URLs that differ and share one canonical form", () => {
    const urls = (["duplicate-canonical-a", "duplicate-canonical-b", "duplicate-canonical-c"] as const).map((name) => shape(name));
    expect(new Set(urls.map((bookmark) => bookmark.url)).size).toBe(3);
    expect(new Set(urls.map((bookmark) => bookmark.urlCanonical)).size).toBe(1);
    for (const workspace of [demo, large]) {
      const canonicals = workspace.bookmarks.map((bookmark) => bookmark.urlCanonical);
      expect(canonicals.length - new Set(canonicals).size).toBeGreaterThan(2);
    }
  });
});

describe("the script", () => {
  const hashes = { admin: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA", member: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$bWVtYmVy" };
  const small = buildDemoInstance({ demoBookmarks: 20, largeBookmarks: 30 });

  it("runs as one transaction under the system role", () => {
    const script = seedScript(small, hashes);
    const lines = script.trimEnd().split("\n");
    expect(lines[1]).toBe("BEGIN;");
    expect(lines[2]).toBe("SET LOCAL ROLE slugbase_system;");
    expect(lines.at(-1)).toBe("COMMIT;");
    expect(script.match(/^(BEGIN|COMMIT);$/gm)).toHaveLength(2);
  });

  it("quotes every value, so markup and quotes stay data", () => {
    const hostile = buildDemoInstance({ demoBookmarks: BOOKMARK_SHAPE_NAMES.length, largeBookmarks: 1 });
    const script = seedScript(hostile, hashes);
    expect(script).toContain("'<img src=x onerror=alert(1)>'");
    expect(script).toContain("'Demo workspace'");
    const tricky = { ...hostile, accounts: hostile.accounts.map((account) => ({ ...account, displayName: "O'Brien'); DROP TABLE accounts; --" })) };
    expect(seedScript(tricky, hashes)).toContain("'O''Brien''); DROP TABLE accounts; --'");
    const withNul = { ...hostile, accounts: hostile.accounts.map((account) => ({ ...account, displayName: "a\0b" })) };
    expect(() => seedScript(withNul, hashes)).toThrow(/NUL/);
  });

  it("splits a large workspace into batches", () => {
    const script = seedScript(buildDemoInstance({ demoBookmarks: 10, largeBookmarks: 1_201 }), hashes);
    expect(script.match(/^INSERT INTO public\.bookmarks /gm)).toHaveLength(1 + 3);
  });
});

describe("the credentials", () => {
  it("are random, long, and verify against their hash", async () => {
    const first = await createCredentials(instance);
    const second = await createCredentials(instance);
    expect(first.passwords.admin).not.toBe(second.passwords.admin);
    expect(first.passwords.admin).not.toBe(first.passwords.member);
    expect(first.passwords.admin.length).toBeGreaterThanOrEqual(24);
    expect(await verify(first.hashes.admin, first.passwords.admin)).toBe(true);
    expect(await verify(first.hashes.admin, first.passwords.member)).toBe(false);
    expect(first.hashes.admin).toMatch(/^\$argon2id\$/);
  });
});

describe("the target", () => {
  const app = "postgres://slugbase_app:slugbase_app_dev_only@localhost:54329/slugbase_dev";
  const migrate = "postgres://slugbase_migrator:slugbase_migrator_dev_only@localhost:54329/slugbase_dev";

  it("matches the development Postgres of compose.dev.yml", () => {
    const compose = readFileSync(new URL("../../../compose.dev.yml", import.meta.url), "utf8");
    expect(compose).toContain(`"${DEVELOPMENT_DATABASE.host}:${String(DEVELOPMENT_DATABASE.port)}:${String(DEVELOPMENT_DATABASE.port)}"`);
    expect(compose).toContain(`-c", "port=${String(DEVELOPMENT_DATABASE.port)}"`);
    expect(compose).toContain(`POSTGRES_DB: ${DEVELOPMENT_DATABASE.name}`);
  });

  it("accepts the development values and connects to the published address", () => {
    expect(developmentTarget({ DATABASE_URL: app, DATABASE_MIGRATE_URL: migrate })).toEqual({
      host: "127.0.0.1",
      port: 54329,
      database: "slugbase_dev",
      username: "slugbase_migrator",
      password: "slugbase_migrator_dev_only",
    });
    expect(developmentTarget({ DATABASE_URL: app.replace("localhost", "127.0.0.1"), DATABASE_MIGRATE_URL: migrate.replace("localhost", "127.0.0.1") }).host).toBe("127.0.0.1");
  });

  it.each([
    ["another host", "postgres://slugbase_app:x@db.internal:54329/slugbase_dev"],
    ["another port", "postgres://slugbase_app:x@localhost:5432/slugbase_dev"],
    ["no port", "postgres://slugbase_app:x@localhost/slugbase_dev"],
    ["another database", "postgres://slugbase_app:x@localhost:54329/postgres"],
    ["a look-alike host", "postgres://slugbase_app:x@localhost.evil.example:54329/slugbase_dev"],
    ["a host hidden in the user", "postgres://localhost:54329@db.internal:54329/slugbase_dev"],
    ["an option that moves the host", "postgres://slugbase_app:x@localhost:54329/slugbase_dev?host=db.internal"],
    ["an IPv6 loopback", "postgres://slugbase_app:x@[::1]:54329/slugbase_dev"],
    ["a socket directory", "postgres://slugbase_app:x@%2Fvar%2Frun%2Fpostgresql:54329/slugbase_dev"],
    ["not a URL", "localhost:54329 slugbase_dev"],
    ["another scheme", "mysql://slugbase_app:x@localhost:54329/slugbase_dev"],
    ["an empty value", ""],
  ])("refuses DATABASE_URL with %s", (_name, value) => {
    expect(() => developmentTarget({ DATABASE_URL: value, DATABASE_MIGRATE_URL: migrate })).toThrow(SeedTargetError);
  });

  it("refuses DATABASE_MIGRATE_URL that points elsewhere, is missing or names another role", () => {
    expect(() => developmentTarget({ DATABASE_URL: app, DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:x@db.internal:54329/slugbase_dev" })).toThrow(SeedTargetError);
    expect(() => developmentTarget({ DATABASE_URL: app })).toThrow(/DATABASE_MIGRATE_URL is not set/);
    expect(() => developmentTarget({ DATABASE_MIGRATE_URL: migrate })).toThrow(/DATABASE_URL is not set/);
    expect(() => developmentTarget({ DATABASE_URL: app, DATABASE_MIGRATE_URL: "postgres://slugbase:slugbase@localhost:54329/slugbase_dev" })).toThrow(/slugbase_migrator/);
  });

  it("never puts a password into the message", () => {
    try {
      developmentTarget({ DATABASE_URL: "postgres://slugbase_app:hunter2-secret@db.internal:54329/slugbase_dev", DATABASE_MIGRATE_URL: migrate });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2-secret");
    }
  });
});
