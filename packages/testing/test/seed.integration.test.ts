import { describe, expect, it } from "vitest";
import type { TestDatabase } from "../src/db.ts";
import { useTestDatabase } from "../src/db.ts";
import { buildDemoInstance, createCredentials, runSeedScript, seedScript, type SeedConnection } from "../src/seed/index.ts";

// The script of `pnpm db:seed` against a database made from the migrations (doc 08 section 3.2), run through psql as
// the migrator, which is how the command runs it.

const HOOK_TIMEOUT_MS = 300_000;
// The password of the migrator on the development Postgres, which the harness itself uses to build a template.
const MIGRATOR_PASSWORD = "slugbase_migrator_dev_only";

const instance = buildDemoInstance();
const credentials = await createCredentials(instance);
const script = seedScript(instance, credentials.hashes);

interface Count {
  n: number;
}

const options = { path: process.env["PATH"] ?? "", secrets: Object.values(credentials.hashes) };

function connectionTo(db: TestDatabase): SeedConnection {
  const server = new URL(process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev");
  return { host: server.hostname, port: Number(server.port === "" ? 5432 : server.port), database: db.name, username: "slugbase_migrator", password: MIGRATOR_PASSWORD };
}

// Reads as slugbase_system, which row-level security does not hold back.
async function asSystem<R extends object>(db: TestDatabase, query: string): Promise<R[]> {
  const result = await db.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return { rows: [...(await tx.unsafe<R[]>(query))] };
  });
  return result.rows;
}

/** The slugs of the demo workspace collide across the two members and are shared, which the member's suggestions name own first (doc 02 sections 6.2, 6.3 and 8). */
async function expectSlugsAndShares(db: TestDatabase): Promise<void> {
  const [admin, member] = instance.accounts;
  const [workspace] = instance.workspaces;
  if (admin === undefined || member === undefined || workspace === undefined) {
    throw new Error("the demo instance has two accounts and a workspace");
  }
  expect(
    await asSystem<{ slug: string; owners: number; forwarding: number }>(
      db,
      `SELECT slug, count(DISTINCT owner_id)::int AS owners, count(*) FILTER (WHERE forwarding)::int AS forwarding FROM bookmarks WHERE workspace_id = '${workspace.id}' AND slug IS NOT NULL GROUP BY slug ORDER BY slug`,
    ),
  ).toEqual([
    { slug: "docs", owners: 2, forwarding: 2 },
    { slug: "mail", owners: 2, forwarding: 2 },
    { slug: "standup", owners: 1, forwarding: 1 },
    { slug: "wiki", owners: 2, forwarding: 2 },
  ]);
  expect(
    await asSystem<{ folders: number; filed: number; folder_shares: number; bookmark_shares: number }>(
      db,
      `SELECT (SELECT count(*)::int FROM folders WHERE workspace_id = '${workspace.id}') AS folders, (SELECT count(*)::int FROM folder_bookmarks WHERE workspace_id = '${workspace.id}') AS filed,
              (SELECT count(*)::int FROM folder_shares WHERE workspace_id = '${workspace.id}') AS folder_shares, (SELECT count(*)::int FROM bookmark_shares WHERE workspace_id = '${workspace.id}') AS bookmark_shares`,
    ),
  ).toEqual([{ folders: 1, filed: 2, folder_shares: 1, bookmark_shares: 1 }]);
  const suggestionsFor = (accountId: string, prefix: string) =>
    db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', ${workspace.id}, true)`;
      return tx<{ slug: string; access: string }[]>`SELECT slug, access FROM sys_go_suggest(${prefix}) ORDER BY access <> 'owner', slug`;
    });
  expect(await suggestionsFor(member.id, "d")).toEqual([{ slug: "docs", access: "owner" }]);
  expect(await suggestionsFor(member.id, "m")).toEqual([{ slug: "mail", access: "owner" }, { slug: "mail", access: "folder" }]);
  expect(await suggestionsFor(member.id, "s")).toEqual([{ slug: "standup", access: "folder" }]);
  expect(await suggestionsFor(member.id, "w")).toEqual([{ slug: "wiki", access: "owner" }, { slug: "wiki", access: "direct" }]);
  expect(await suggestionsFor(admin.id, "s")).toEqual([{ slug: "standup", access: "owner" }]);
}

describe("the seed script through psql as the migrator", () => {
  const database = useTestDatabase();

  it("rolls the whole script back on a failure, without the password or a hash in the message", { timeout: HOOK_TIMEOUT_MS }, async () => {
    const db = database();
    const broken = seedScript(buildDemoInstance({ demoBookmarks: 5, largeBookmarks: 5 }), credentials.hashes).replace("COMMIT;", "SELECT 1/0;\nCOMMIT;");
    const failure = await runSeedScript(connectionTo(db), broken, options).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/division by zero/);
    expect(failure?.message).not.toContain(MIGRATOR_PASSWORD);
    expect(failure?.message).not.toContain("$argon2id");
    const rows = await asSystem<Count>(db, "SELECT ((SELECT count(*) FROM accounts) + (SELECT count(*) FROM workspaces) + (SELECT count(*) FROM bookmarks))::int AS n");
    expect(rows[0]?.n).toBe(0);
  });

  it("seeds accounts, workspaces and bookmarks with each workspace's counter equal to its rows", { timeout: HOOK_TIMEOUT_MS }, async () => {
    const db = database();
    await runSeedScript(connectionTo(db), script, options);
    expect(
      await asSystem<{ email: string; is_instance_admin: boolean; has_password: boolean; verified: boolean }>(
        db,
        "SELECT email::text, is_instance_admin, password_hash LIKE '$argon2id$%' AS has_password, email_verified_at IS NOT NULL AS verified FROM accounts ORDER BY email",
      ),
    ).toEqual([
      { email: "admin@example.test", is_instance_admin: true, has_password: true, verified: true },
      { email: "member@example.test", is_instance_admin: false, has_password: true, verified: true },
    ]);
    expect(
      await asSystem<{ name: string; bookmark_count: number; rows: number }>(
        db,
        "SELECT w.name, w.bookmark_count, (SELECT count(*)::int FROM bookmarks b WHERE b.workspace_id = w.id AND b.plan_archived_at IS NULL) AS rows FROM workspaces w ORDER BY w.name",
      ),
    ).toEqual([
      { name: "Demo workspace", bookmark_count: 300, rows: 300 },
      { name: "Large workspace", bookmark_count: 5_000, rows: 5_000 },
    ]);
    expect(
      await asSystem<{ name: string; email: string; role: string }>(
        db,
        "SELECT w.name, a.email::text, m.role::text FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id JOIN accounts a ON a.id = m.account_id ORDER BY w.name, a.email",
      ),
    ).toEqual([
      { name: "Demo workspace", email: "admin@example.test", role: "owner" },
      { name: "Demo workspace", email: "member@example.test", role: "member" },
      { name: "Large workspace", email: "admin@example.test", role: "owner" },
    ]);
    const [shapes] = await asSystem<{ markup: number; pinned: number; opened: number; unopened: number; duplicates: number; longest: number }>(
      db,
      `SELECT count(*) FILTER (WHERE title = '<img src=x onerror=alert(1)>')::int AS markup,
              count(*) FILTER (WHERE pinned_at IS NOT NULL)::int AS pinned,
              count(*) FILTER (WHERE open_count > 0 AND last_opened_at IS NOT NULL)::int AS opened,
              count(*) FILTER (WHERE open_count = 0 AND last_opened_at IS NULL)::int AS unopened,
              (count(*) - count(DISTINCT workspace_id::text || url_canonical))::int AS duplicates,
              max(char_length(title))::int AS longest
       FROM bookmarks`,
    );
    expect(shapes?.markup).toBe(2);
    expect(shapes?.pinned).toBeGreaterThan(2);
    expect(shapes?.opened).toBeGreaterThan(1_000);
    expect(shapes?.unopened).toBeGreaterThan(1_000);
    expect(shapes?.duplicates).toBeGreaterThan(4);
    expect(shapes?.longest).toBe(300);
    await expectSlugsAndShares(db);
  });

  it("leaves the demo workspace readable by its owner through row-level security", { timeout: HOOK_TIMEOUT_MS }, async () => {
    const db = database();
    const [admin] = instance.accounts;
    const [workspace] = instance.workspaces;
    if (admin === undefined || workspace === undefined) {
      throw new Error("the demo instance has an account and a workspace");
    }
    const rows = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${admin.id}, true), set_config('app.workspace_id', ${workspace.id}, true)`;
      return tx<Count[]>`SELECT count(*)::int AS n FROM bookmarks`;
    });
    expect(rows[0]?.n).toBe(300);
  });

  it("refuses to run twice and leaves what the first run wrote", { timeout: HOOK_TIMEOUT_MS }, async () => {
    const db = database();
    const again = seedScript(buildDemoInstance({ demoBookmarks: 10, largeBookmarks: 10 }), credentials.hashes);
    await expect(runSeedScript(connectionTo(db), again, options)).rejects.toThrow(/already has an account/);
    const rows = await asSystem<Count>(db, "SELECT count(*)::int AS n FROM bookmarks");
    expect(rows[0]?.n).toBe(5_300);
  });
});
