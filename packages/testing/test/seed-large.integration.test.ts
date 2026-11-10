import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTestDatabase } from "@slugbase/db/testing";
import { describe, expect, it } from "vitest";
import { assertBookmarkCountMatches } from "../src/bookmark-count.ts";
import { useTestDatabase } from "../src/db.ts";
import { buildLargeInstance, perfServer, preparePerfInstance, runSeedScript, seedLargeInstance } from "../src/seed/index.ts";

// The large instance, at a small size, written into a database made from the migrations (doc 08 section 3.2) the way the
// performance run writes it, and read back through the application role.

const execFileAsync = promisify(execFile);
const HOOK_TIMEOUT_MS = 300_000;
const MAX_STOP_MS = 10_000;
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$c3RhbmQtaW4taGFzaC1mb3ItdGVzdHMtb25seS0wMDAwMDAwMDAw";

const harnessUrl = process.env["SLUGBASE_TEST_PG_URL"];
const DEV_SERVER_URL = "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev";
const server = perfServer(harnessUrl ?? DEV_SERVER_URL, process.env["PATH"] ?? "", harnessUrl);
const instance = buildLargeInstance({ bookmarks: 600, workspaces: 6 });
const [large] = instance.workspaces;
const admin = instance.accounts.find((account) => account.email === instance.fixtures.email);
if (large === undefined || admin === undefined) {
  throw new Error("the large instance has a large workspace and its admin");
}

describe("seeding the large instance into a harness database", () => {
  const database = useTestDatabase();

  it("writes every workspace, bookmark, tag, folder and link, and leaves each workspace's counter equal to its rows", { timeout: HOOK_TIMEOUT_MS }, async () => {
    const db = database();
    const counts = await seedLargeInstance(db, server, instance, PASSWORD_HASH);
    expect(counts).toEqual({ database: db.name, accounts: instance.accounts.length, workspaces: 7, bookmarks: 600 + 6 * 10, largestWorkspace: large.bookmarks.filter((bookmark) => bookmark.planArchivedAt === null).length });
    const rows = await db.owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ tags: number; folders: number; tagged: number; filed: number; slugged: number; forwarding: number; archived: number; teams: number; teamMembers: number; bookmarkShares: number; folderShares: number; stale: number }[]>`
        SELECT (SELECT count(*)::int FROM tags) AS tags, (SELECT count(*)::int FROM folders) AS folders,
               (SELECT count(*)::int FROM bookmark_tags) AS tagged, (SELECT count(*)::int FROM folder_bookmarks) AS filed,
               (SELECT count(*)::int FROM bookmarks WHERE slug IS NOT NULL) AS slugged, (SELECT count(*)::int FROM bookmarks WHERE forwarding) AS forwarding,
               (SELECT count(*)::int FROM bookmarks WHERE plan_archived_at IS NOT NULL) AS archived,
               (SELECT count(*)::int FROM teams) AS teams, (SELECT count(*)::int FROM team_members) AS "teamMembers", (SELECT count(*)::int FROM bookmark_shares) AS "bookmarkShares",
               (SELECT count(*)::int FROM folder_shares) AS "folderShares"`;
    });
    const all = instance.workspaces;
    expect(rows[0]).toEqual({
      tags: all.reduce((sum, workspace) => sum + workspace.tags.length, 0),
      folders: all.reduce((sum, workspace) => sum + workspace.folders.length, 0),
      tagged: all.reduce((sum, workspace) => sum + workspace.bookmarkTags.length, 0),
      filed: all.reduce((sum, workspace) => sum + workspace.folderBookmarks.length, 0),
      slugged: all.reduce((sum, workspace) => sum + workspace.bookmarks.filter((bookmark) => bookmark.slug !== null).length, 0),
      forwarding: all.reduce((sum, workspace) => sum + workspace.bookmarks.filter((bookmark) => bookmark.forwarding).length, 0),
      archived: all.reduce((sum, workspace) => sum + workspace.bookmarks.filter((bookmark) => bookmark.planArchivedAt !== null).length, 0),
      teams: 1,
      teamMembers: 3,
      bookmarkShares: large.bookmarkShares.length,
      folderShares: large.folderShares.length,
    });
    expect(large.bookmarkShares.length).toBeGreaterThan(0);
    expect(rows[0]?.archived).toBeGreaterThan(0);
    await assertBookmarkCountMatches(db);
  });

  it("leaves the visibility map of every table full after the seed, as autovacuum would", { timeout: HOOK_TIMEOUT_MS }, async () => {
    // A database of its own: the shared one already holds the instance the first test seeded.
    const db = await createTestDatabase({ serverUrl: harnessUrl ?? DEV_SERVER_URL });
    try {
      await seedLargeInstance(db, server, buildLargeInstance({ bookmarks: 600, workspaces: 6 }), PASSWORD_HASH);
      const tables = await db.owner<{ name: string; pages: number; visible: number }[]>`
        SELECT relname AS name, relpages AS pages, relallvisible AS visible FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'm') ORDER BY relname`;
      const read = new Map(tables.map((table) => [table.name, table]));
      expect(read.get("bookmarks")?.pages).toBeGreaterThan(0);
      expect(read.get("bookmark_tags")?.pages).toBeGreaterThan(0);
      expect(tables.filter((table) => table.visible < table.pages)).toEqual([]);
    } finally {
      await db.drop();
    }
  });

  it("leaves row-level security enabled and forced on every tenant table, and hands the server a role that bypasses nothing and owns no table", { timeout: HOOK_TIMEOUT_MS }, async () => {
    const prepared = await preparePerfInstance({
      serverUrl: process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev",
      path: process.env["PATH"] ?? "",
      harnessUrl,
      bookmarks: 600,
      workspaces: 6,
    });
    try {
      expect(prepared.instance.fixtures.archivedSlugs.length).toBeGreaterThan(0);
      const url = new URL(prepared.appUrl);
      // The query runs over the URL the instance hands out, in the database it seeded, as the role the server runs as.
      const query = `SELECT json_build_object(
        'user', current_user,
        'bypass', (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user),
        'owned', (SELECT count(*) FROM pg_class c WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S')),
        'tenantTables', (SELECT count(*) FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')),
        'unprotected', (SELECT coalesce(json_agg(c.relname ORDER BY c.relname), '[]'::json) FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT (c.relrowsecurity AND c.relforcerowsecurity))
      )`;
      const { stdout } = await execFileAsync("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query], {
        env: {
          PATH: process.env["PATH"] ?? "",
          PGHOST: url.hostname.replace(/^\[|\]$/gu, ""),
          PGPORT: url.port,
          PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
          PGUSER: decodeURIComponent(url.username),
          PGPASSWORD: decodeURIComponent(url.password),
          PGCONNECT_TIMEOUT: "10",
        },
        timeout: 60_000,
      });
      const role = JSON.parse(stdout) as { user: string; bypass: boolean; owned: number; tenantTables: number; unprotected: string[] };
      expect(role).toEqual({ user: "slugbase_app", bypass: false, owned: 0, tenantTables: role.tenantTables, unprotected: [] });
      expect(role.tenantTables).toBeGreaterThan(10);
    } finally {
      await prepared.drop();
    }
  });

  it("reads each workspace's own rows and no other's through row-level security", { timeout: HOOK_TIMEOUT_MS }, async () => {
    const db = database();
    const other = instance.workspaces[1];
    if (other === undefined) {
      throw new Error("the instance has a second workspace");
    }
    const slug = instance.fixtures.slugs[0];
    const read = async (workspaceId: string) =>
      db.app.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${admin.id}, true), set_config('app.workspace_id', ${workspaceId}, true)`;
        return tx<{ n: number; withSlug: number }[]>`SELECT count(*)::int AS n, count(*) FILTER (WHERE slug = ${slug ?? ""})::int AS "withSlug" FROM bookmarks`;
      });
    expect((await read(large.id))[0]).toEqual({ n: large.bookmarks.length, withSlug: 1 });
    expect((await read(other.id))[0]).toEqual({ n: other.bookmarks.length, withSlug: 0 });
  });

  it("refuses to seed a database that already has accounts and leaves what is there", { timeout: HOOK_TIMEOUT_MS }, async () => {
    const db = database();
    await expect(seedLargeInstance(db, server, buildLargeInstance({ bookmarks: 20, workspaces: 1 }), PASSWORD_HASH)).rejects.toThrow(/already has accounts/);
    const rows = await db.owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmarks`;
    });
    expect(rows[0]?.n).toBe(660);
  });

  it("drops the database it is seeding when the signal aborts the seeding", { timeout: HOOK_TIMEOUT_MS }, async () => {
    const db = database();
    const abort = new AbortController();
    let name: string | undefined;
    const prepared = preparePerfInstance({
      serverUrl: process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev",
      path: process.env["PATH"] ?? "",
      harnessUrl,
      bookmarks: 40_000,
      workspaces: 200,
      signal: abort.signal,
      onDatabase: (created) => {
        name = created;
      },
    });
    const settled = prepared.then(
      () => "seeded",
      (error: unknown) => (error instanceof Error ? error.message : "failed"),
    );
    // psql runs as the application name of the seed, in the database this call created.
    const seeding = async (): Promise<boolean> => {
      if (name === undefined) {
        return false;
      }
      const rows = await db.owner<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'slugbase-seed' AND datname = ${name}`;
      return (rows[0]?.n ?? 0) > 0;
    };
    const deadline = Date.now() + 120_000;
    let running = await seeding();
    while (!running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      running = await seeding();
    }
    if (name === undefined || !running) {
      throw new Error("the seed never ran psql");
    }
    const seeded = name;
    abort.abort();
    expect(await settled).toMatch(/interrupted/);
    const left = await db.owner<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${seeded}`;
    expect(left[0]?.n).toBe(0);
  });

  it("ends psql when the signal aborts a script that is running", { timeout: HOOK_TIMEOUT_MS }, async () => {
    const db = database();
    const abort = new AbortController();
    const running = runSeedScript(
      { host: server.host, port: server.port, database: db.name, username: "slugbase_migrator", password: "slugbase_migrator_dev_only" },
      "SELECT pg_sleep(60);",
      { path: server.path, signal: abort.signal },
    );
    const settled = running.then(
      () => "finished",
      (error: unknown) => (error instanceof Error ? error.message : "failed"),
    );
    const deadline = Date.now() + 30_000;
    let sleeping = false;
    while (!sleeping && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const rows = await db.owner<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${db.name} AND application_name = 'slugbase-seed'`;
      sleeping = (rows[0]?.n ?? 0) > 0;
    }
    expect(sleeping).toBe(true);
    const aborted = Date.now();
    abort.abort();
    expect(await settled).toMatch(/interrupted/);
    expect(Date.now() - aborted).toBeLessThan(MAX_STOP_MS);
  });
});
